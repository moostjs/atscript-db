---
outline: deep
---

# Optimistic Concurrency (Row Versioning)

<!--@include: ../_experimental-warning.md-->

Atscript DB supports first-class **optimistic concurrency control (OCC)** via a server-managed integer version column. A single annotation makes the column auto-bump on every write; the inline `$cas` operator turns any write into a conditional one that rejects stale read-modify-write submissions.

## When You Need This

Atscript DB has two atomic primitives out of the box: **insert** and [field ops](./update-patch#field-ops) (`$inc`, `$dec`, `$mul`). Every other write is last-write-wins — a caller reads a row, computes a patch in JS, and submits it via `updateOne`. Between read and write there is a race window in which another writer can change the row, and the second writer silently overwrites the first.

That window is fine for many fields (display name, profile bio). It is **not** fine for state machines with read-modify-write semantics:

- Consuming a single-use credential (backup code, magic-link token) — two concurrent consumers can both succeed and use the credential twice.
- Adding to a JSON-column collection (`mfa.methods[]`, `trustedDevices[]`) — concurrent appenders each compute their own union and one entry is lost.
- Confirming an MFA enrollment or transitioning a workflow step stored in a row column.
- Inventory decrement with business rules (no-go-below-zero) — `$inc(-1)` is atomic but the rule check on the resulting value is not.

The common pattern is "read state, compute next state, write state, fail if state changed under us." That is OCC, and it is the de-facto enterprise primitive in every major ORM. Atscript DB exposes it via a single annotation, an inline `$cas` operator, and a thin auto-lift in [`@atscript/moost-db`](/http/crud#occ-over-http) so REST clients get OCC seamlessly.

## The `@db.column.version` Annotation

Mark a numeric column as the row's version:

```atscript
interface Task {
    @meta.id @db.default.increment id: int
    title: string
    status: 'open' | 'done'

    @db.column.version
    version: int
}
```

Constraints (enforced at compile time):

- **At most one** version column per table — composite versioning makes no semantic sense.
- The field must resolve to a SQL `INTEGER` (or Mongo `Number`). String / timestamp versioning is not supported.
- The annotation is **boolean only** — column renaming uses the existing [`@db.column.renamed`](/api/tables) annotation.
- The field is **server-managed**: the adapter sets it to `0` on insert and increments it by `1` on every successful update. See [defaults](./defaults#version-defaults).

::: tip Auto-bump is mandatory
Every successful write to a versioned row increments `version` by 1, whether or not `$cas` was supplied. This is the property that makes OCC actually work — if the version column did not auto-increment, opting in to `$cas` would silently degrade to no protection.
:::

Callers MAY read the version (and SHOULD, in order to pass `$cas`) but **MUST NOT** write it directly. See [Direct-write rejection](#direct-write-rejection).

## The `$cas` Operator

`$cas` is a top-level payload operator — a sibling to plain SET fields and `$inc`/`$mul` field ops. It is the only opt-in surface for CAS.

```typescript
const ok = await tasks.updateOne({
  id: 1,
  status: "done",
  $cas: { version: row.version }, // ← opt-in conflict detection
});

if (ok.matchedCount === 0) {
  // Either the row doesn't exist OR another writer touched it. Retry.
}
```

The map shape (`{ [versionColumn]: N }`) keys by the table's version column name. No exception is thrown on mismatch — the call returns `{ matchedCount: 0, modifiedCount: 0 }` and the caller decides what to do.

::: tip No throw on mismatch
Throwing creates an asymmetry where every retry path needs `try/catch` instead of a clean `if (!result.matchedCount)`. Distinguish "row missing" from "version mismatch" with an extra `findOne` if you care; for the dominant retry-on-conflict use case both states warrant the same response.
:::

### `$cas` with `bulkUpdate`

Each payload in `bulkUpdate` carries its own `$cas`. Rows with matching versions are updated; rows that mismatch (or do not exist) are **silently skipped**. `modifiedCount` reflects how many actually applied.

```typescript
await tasks.bulkUpdate([
  { id: 1, status: "done", $cas: { version: 7 } },
  { id: 2, status: "done", $cas: { version: 3 } },
  { id: 3, status: "done" }, // no $cas — always applies
]);
```

This is the version-locked batch primitive — partial success is the point. Detect partial failure via `matchedCount < items.length`.

### `$cas` with `replaceOne`

`replaceOne` supports `$cas` with the same semantics as `updateOne`: predicate filters by version, bump on success.

```typescript
await tasks.replaceOne({
  id: 1,
  title: "Bake bread",
  status: "done",
  $cas: { version: 4 },
});
```

### `$cas` is NOT supported on `updateMany`

`updateMany(filter, data)` always writes through, auto-bumping the version but never checking it. A single `expectedVersion` cannot sensibly match N rows with different versions. Per-row version locking is the job of `bulkUpdate` (see above).

```typescript
// ✅ Auto-bumps every matched row's version
await tasks.updateMany({ status: "open" }, { status: "done" });

// ❌ Throws — `$cas` is not allowed on updateMany
await tasks.updateMany({ status: "open" }, { status: "done", $cas: { version: 1 } });
```

### Composition with field operations

`$cas` composes atomically with `$inc` / `$dec` / `$mul`. The adapter generates a single statement like `UPDATE … SET counter = counter + 1, version = version + 1 WHERE id = ? AND version = ?` — either everything applies or nothing does.

```typescript
import { $inc } from "@atscript/db/ops";

await tasks.updateOne({
  id: 1,
  counter: $inc(),
  $cas: { version: 4 },
});
// Both the counter increment AND the version bump happen atomically,
// gated by the version predicate.
```

## `withOptimisticRetry` — The Retry Helper

Raw CAS works, but every consumer writing a retry loop is friction. `withOptimisticRetry` covers the 90% case:

```typescript
import { withOptimisticRetry } from "@atscript/db";

await withOptimisticRetry(
  users,
  { id }, // filter — typically the primary key
  async (row) => {
    // Pure function: receives the current row, returns the patch.
    return {
      backupCodes: row.backupCodes.filter((h) => h !== usedHash),
    };
  },
  { maxAttempts: 5 },
);
```

What it does, in order:

1. `findOne(filter)` — read the current row (throws `DbError("NOT_FOUND")` if missing).
2. Call `mutator(row)` to compute the patch.
3. `updateOne({ ...filter, ...patch, $cas: { [versionColumn]: row.version } })`.
4. On `matchedCount === 0`, retry from step 1 up to `maxAttempts` times.
5. After `maxAttempts` consecutive conflicts, throw [`CasExhaustedError`](#casexhaustederror).

The second parameter is a **filter** (not just an id) so composite-key and non-id tables work without contortion. The helper requires the table to declare `@db.column.version` — otherwise it throws `DbError("INVALID_QUERY")` (silently degrading to last-write-wins would defeat the purpose).

### Options

| Option        | Type                                 | Default | Effect                                                                                                                |
| ------------- | ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `maxAttempts` | `number`                             | `5`     | How many times to re-read and retry before giving up.                                                                 |
| `delay`       | `(attempt: number) => Promise<void>` | none    | Hook invoked between failed attempts. Receives the 1-based attempt number that just failed. Use for backoff + jitter. |

```typescript
await withOptimisticRetry(users, { id }, mutator, {
  maxAttempts: 10,
  delay: async (attempt) => {
    const ms = Math.min(100 * 2 ** attempt, 1000) + Math.random() * 50;
    await new Promise((r) => setTimeout(r, ms));
  },
});
```

This helper is optional sugar — the raw `$cas` API is fine for callers that want explicit control over retry policy.

## Direct-Write Rejection

The version column is server-managed. Any attempt to write it from a payload is rejected at the patch-decomposer layer, **regardless of which write method is used**:

```typescript
// ❌ All three throw DbError("VERSION_COLUMN_WRITE")
await tasks.updateOne({ id: 1, version: 5 });
await tasks.updateOne({ id: 1, version: $inc() });
await tasks.updateOne({ id: 1, version: $mul(2) });

await tasks.replaceOne({ id: 1, title: "x", status: "open", version: 9 });
await tasks.bulkUpdate([{ id: 1, version: 5 }]);
```

The error code is `VERSION_COLUMN_WRITE`. Catch it like any other [`DbError`](./crud#error-handling):

```typescript
import { DbError } from "@atscript/db";

try {
  await tasks.updateOne({ id: 1, version: 5 });
} catch (err) {
  if (err instanceof DbError && err.code === "VERSION_COLUMN_WRITE") {
    // Caller tried to write the version column. Use $cas instead.
  }
}
```

## `CasExhaustedError`

Thrown by [`withOptimisticRetry`](#withoptimisticretry-the-retry-helper) when `maxAttempts` is reached without a successful commit — the target row kept changing under the read-modify-write loop. The error carries the attempt count and the last-observed version, useful for logging hot-row contention:

```typescript
import { CasExhaustedError, withOptimisticRetry } from "@atscript/db";

try {
  await withOptimisticRetry(tokens, { id }, consumeToken);
} catch (err) {
  if (err instanceof CasExhaustedError) {
    console.warn(
      `Token ${id} contended out after ${err.attempts} attempts; ` +
        `last seen version=${err.lastSeenVersion}`,
    );
  }
}
```

`CasExhaustedError` extends `DbError` with `code === "CAS_EXHAUSTED"`.

## Edge Cases & Gotchas

### `updateMany` never CAS-checks

This is a [locked design decision](#alternatives-considered). A single `expectedVersion` cannot sensibly match N rows with different versions; per-row version locking belongs in `bulkUpdate`. Passing `$cas` to `updateMany` throws.

### `replaceOne` supports CAS

`replaceOne({ …, $cas: { version: N } })` behaves identically to `updateOne` from a CAS perspective: predicate filters by version, bump on success, `matchedCount: 0` on mismatch.

### `$cas` + field ops compose atomically

`{ id, counter: $inc(), $cas: { version: 4 } }` produces a single statement that either applies both the increment and the version bump or applies neither — there is no intermediate state.

### Version on insert

`@db.column.version` implies a `0` default at insert time — see [Version defaults](./defaults#version-defaults). You do not need to add `@db.default '0'` explicitly.

### External writers do not auto-bump

Any process that writes to a versioned row **outside** the adapter (raw SQL migrations, ETL pipelines, ops scripts, replication catchup) will NOT bump the version column. A subsequent CAS-protected caller will then succeed against a stale state without knowing.

This is a known limitation of the application-layer approach. Consumers that need to defend against this should install a per-engine database trigger on the versioned table that auto-bumps `version` on every UPDATE. Atscript DB does not install such triggers.

### Counter overflow

`int32` saturates after ~2.1B updates. For tables that turn over that often, use `int64` via the existing precision semantics. Default `int32` is plenty for nearly every realistic scenario (2.1B writes to a single row is ~70 years of one write per second).

### JSON columns

[`@db.json`](./update-patch#json-fields) columns are independent of CAS. Version operates at the row level; the JSON sub-document is replaced wholesale on update, and the version bump applies to the row regardless of which fields changed.

## End-to-End Example: Consuming a Backup Code

A classic single-use-credential race — two concurrent consumers must not both succeed:

```atscript
interface User {
    @meta.id @db.default.uuid id: string
    email: string
    backupCodes: string[]

    @db.column.version
    version: int
}
```

```typescript
import { withOptimisticRetry } from "@atscript/db";
import { sha256 } from "./crypto";

async function consumeBackupCode(userId: string, code: string): Promise<boolean> {
  const hash = sha256(code);
  let consumed = false;

  await withOptimisticRetry(
    users,
    { id: userId },
    (user) => {
      if (!user.backupCodes.includes(hash)) {
        return {}; // No-op patch — code not found. Still bumps version (harmless).
      }
      consumed = true;
      return {
        backupCodes: user.backupCodes.filter((h) => h !== hash),
      };
    },
    { maxAttempts: 5 },
  );

  return consumed;
}
```

Two concurrent `consumeBackupCode` calls with the same code: exactly one returns `true`, the other re-reads after the first commits, finds the code gone, and returns `false`. Guaranteed by the `$cas` predicate.

## REST Clients

When using [`@atscript/moost-db`](/http/crud#occ-over-http), HTTP clients get OCC for free: round-trip the `version` field in your PATCH / PUT body and the controller auto-lifts it to `$cas`. Mismatches surface as `409 Conflict`; missing rows surface as `404 Not Found`. See [CRUD Endpoints — OCC over HTTP](/http/crud#occ-over-http).

## Alternatives Considered

These are intentionally **not** supported in v1 — listed so you know they were considered and rejected:

- **Timestamp-based versioning** — suffers from clock skew on distributed writers and millisecond collision under high load.
- **Hash-based versioning** — pushes hashing into every read+write; harder to reason about than monotonic integers.
- **Per-field versioning** — strictly more granular (concurrent edits to disjoint fields succeed) but significantly more complex; the 80% use case is "this row's state machine moved on," which is row-level by nature.
- **Pessimistic locking (`SELECT FOR UPDATE`)** — separate concept; could be a future addition but not OCC.
- **`If-Match` header** — body-embedded `version` is simpler for SPA clients that already round-trip the row.
- **`opts.expectedVersion` parameter** — duplicate surface for the same semantics; `$cas` is the only way to opt in.

## Next Steps

- [Update & Patch](./update-patch#cas-operator) — operator catalog, including `$cas` alongside `$inc` / `$dec` / `$mul`.
- [CRUD Operations](./crud#updating-records) — basic `updateOne` / `replaceOne` reference.
- [Defaults & Generated Values](./defaults#version-defaults) — how `@db.column.version` implies its default.
- [HTTP CRUD — OCC over HTTP](/http/crud#occ-over-http) — REST behavior, 409 body shape, bulk semantics.
