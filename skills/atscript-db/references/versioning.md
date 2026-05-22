# versioning (optimistic concurrency)

First-class optimistic concurrency control (OCC) for read-modify-write workflows. Use `$cas` to make any update conditional on the row's current version; the adapter auto-bumps the version on every successful write.

**TL;DR.** Annotate a column with `@db.column.version`. Pass `$cas: { version: row.version }` in `updateOne` / `replaceOne` / `bulkUpdate` payloads. On mismatch you get `matchedCount: 0` (no throw); retry. Over HTTP, include `version` in PATCH/PUT body — controller auto-lifts it to `$cas` and returns `409` with `currentVersion` on conflict.

## When to use it

Reach for `$cas` whenever the next state depends on the current state and a concurrent writer could win the race in between:

- Single-use credentials (backup codes, magic-link tokens) — two consumers must not both succeed.
- Appending to a JSON / array column (`mfa.methods[]`, `trustedDevices[]`) — concurrent appenders must not lose each other's entries.
- State-machine transitions stored in a row column (`status: 'pending' -> 'confirmed'`).
- Inventory decrement with business rules that `$inc(-1)` alone can't enforce (no go-below-zero).

For pure counters use `$inc` ([patch.md](./patch.md#field-ops)) — it's atomic without a version. For "last write wins" (display name, profile bio) just skip `$cas` entirely.

## The annotation

```atscript
@db.table 'users'
interface User {
    @meta.id @db.default.uuid
    id: string
    name: string
    @db.column.version
    version: int      // server-managed; integer; non-optional; at most one per table
}
```

Constraints:

- Field type MUST resolve to `int` (SQL `INTEGER`, Mongo `Number`).
- At most one version column per table.
- Field must be non-optional. Schema sync emits `NOT NULL DEFAULT 0`; existing rows backfill to `0` automatically on `ALTER TABLE`.
- Default column name is `version`. Renaming the field via `@db.column 'v'` is **not currently recommended** — see [§ Limitations](#limitations).

The field appears in `findOne` / `findMany` results like any other column. Clients are expected to round-trip it back on writes.

## SDK — `$cas` operator

`$cas` is a top-level payload operator (sibling to plain SET fields and `$inc` / `$mul`):

```ts
const row = await users.findOne({ filter: { id } });

const result = await users.updateOne({
  id,
  status: "active",
  $cas: { version: row.version }, // ← opt-in conflict detection
});

if (result.matchedCount === 0) {
  // Either the row doesn't exist OR another writer bumped the version.
  // Re-read and retry, or surface as 409 to the caller.
}
```

**Auto-bump is mandatory.** Every successful write to a versioned table bumps the version column, whether or not `$cas` was supplied. The CAS predicate is what's opt-in — the bump is not.

**Mismatch contract.** `matchedCount === 0` is the only signal. No exception is thrown. `updateOne` / `replaceOne` / `bulkUpdate` follow the same shape.

**`updateMany` never CAS-checks.** A single `expectedVersion` cannot sensibly match N rows. Passing `$cas` to `updateMany` throws. Use `bulkUpdate` with per-item `$cas` for the per-row case:

```ts
await users.bulkUpdate([
  { id: "u1", status: "active", $cas: { version: 7 } }, // updated if v=7
  { id: "u2", status: "active", $cas: { version: 3 } }, // skipped if stale
  { id: "u3", status: "active" }, // no $cas → always wins
]);
// modifiedCount reflects how many actually applied.
```

**Direct writes to the version column are rejected.** Plain SET, `$inc`, or `$mul` targeting the version field throws `DbError("VERSION_COLUMN_WRITE")` at the patch-decomposer layer:

```ts
await users.updateOne({ id, version: 5 }); // throws
await users.updateOne({ id, version: $inc(1) }); // throws
```

This rule applies to every write path (`updateOne`, `updateMany`, `replaceOne`, `bulkUpdate`, `bulkReplace`). Use `$cas` to read the value; let the adapter manage the write.

**Composition with field ops.** `$cas` + `$inc` apply atomically in a single statement:

```ts
await tasks.updateOne({
  id,
  counter: $inc(1),
  $cas: { version: row.version },
});
// SQL: UPDATE … SET counter = counter + 1, version = version + 1 WHERE id = ? AND version = ?
```

## `withOptimisticRetry` — the retry helper

Raw `$cas` works, but typical consumers want a read → mutate → write → retry loop. The helper covers 90% of cases:

```ts
import { withOptimisticRetry, CasExhaustedError } from "@atscript/db";

// Backup-code consumption — must be single-use under concurrency.
try {
  await withOptimisticRetry(
    users,
    { id: userId },
    async (row) => {
      const hashed = await hash(submittedCode);
      if (!row.backupCodes.includes(hashed)) {
        throw new Error("invalid code");
      }
      return {
        backupCodes: row.backupCodes.filter((h) => h !== hashed),
      };
    },
    { maxAttempts: 5 },
  );
} catch (e) {
  if (e instanceof CasExhaustedError) {
    // Contention exceeded maxAttempts — surface as 503 or backoff externally.
  }
  throw e;
}
```

Mechanics:

1. `findOne(filter)` reads the current row (must return a row, else helper throws).
2. Mutator receives the row, returns a patch object.
3. `updateOne` with `$cas: { [versionColumn]: row.version }` and the patch.
4. On `matchedCount === 0`, loop. Up to `maxAttempts` (default `5`).
5. Throws `CasExhaustedError` if every attempt loses the race.

The filter argument is a full `FilterExpr` (not just an id) so composite keys and non-id tables work. Mutator may return `undefined` to abort without writing.

For custom retry policies (exponential backoff, jitter, custom logging) just write the loop by hand — `$cas` is a 3-line primitive.

## HTTP — moost-db auto-lift

`@atscript/moost-db` makes OCC seamless for REST clients on versioned tables: the controller auto-lifts a `version` field in the body to `$cas`.

### `/meta` exposes `versionColumn`

```jsonc
// GET /users/meta
{ "primaryKeys": ["id"], "versionColumn": "version", "fields": { … }, … }

// Non-versioned tables omit the key entirely.
{ "primaryKeys": ["id"], "fields": { … }, … }
```

Clients use this pointer to decide whether to round-trip `version`. UI generators may render it read-only.

### PATCH / PUT auto-lift

```
PATCH /users/
Body: { "id": "u1", "name": "Ada", "version": 4 }
```

Controller behavior:

- `version` present → stripped from SET, lifted to `$cas: { version: 4 }`, dispatched to `updateOne` / `replaceOne`.
- `version` absent → write goes through with no `$cas` (last-write-wins; client opted out).

Policy is presence-based. No 428 "Precondition Required" gate.

### Conflict response — 409

When CAS misses, the controller does a single disambiguation `findOne(id)`:

- Row missing → `404 Not Found`.
- Row present → `409 Conflict` with body:

```jsonc
{
  "statusCode": 409,
  "error": "Conflict", // overridden by Wooks framework
  "message": "version_mismatch",
  "kind": "version_mismatch", // ← discriminator (use this)
  "currentVersion": 6, // ← row's current version
}
```

**Discriminate on `kind === "version_mismatch"` + `currentVersion`.** The `error` field is overridden by the Wooks framework and not a reliable discriminator. The 404 path fires only when the row is actually gone — `findOne` is paid only on the conflict path, never on the happy path.

Standard usage from a client: catch 409, re-GET the row, re-apply changes, retry the PATCH with the fresh `version`.

### Bulk PATCH / PUT

Each item in an array body carries its own optional `version`. Mismatches are **silently skipped**; the response is the aggregate `{ matchedCount, modifiedCount }` shape:

```
PATCH /users/
Body: [
  { "id": "u1", "name": "a", "version": 5 },  // matches → applies
  { "id": "u2", "name": "b", "version": 9 },  // stale   → skipped
  { "id": "u3", "name": "c" }                 // no $cas → always applies
]
Response: 200 OK { "matchedCount": 2, "modifiedCount": 2 }
```

Detect partial failure via `matchedCount < items.length`. **Per-item conflict status (e.g. 207 Multi-Status with per-row entries) is deferred** — see [§ Limitations](#limitations).

## Migration story

OCC is opt-in per table. Tables without `@db.column.version` behave exactly as before.

1. Add `@db.column.version version: int` to the `.as` file.
2. Run schema sync — column is added with `NOT NULL DEFAULT 0`; existing rows backfill to `0`.
3. Existing call sites that don't pass `$cas` continue to work (last-write-wins, same as today).
4. Adopt `$cas` / `withOptimisticRetry` at the sites that need it.

No breaking changes. No data migration beyond the one column addition.

## Adapter notes

| Adapter                   | Mechanism                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite / Postgres / MySQL | `UPDATE … SET col=…, version = version + 1 WHERE pk = ? AND version = ?` — single atomic statement.                                                                  |
| MongoDB                   | `updateOne({ _id, version }, { $set: …, $inc: { version: 1 } })`. `replaceOne` uses an aggregation pipeline (`$replaceWith` + `$add`) to keep replace + bump atomic. |

Behavior is identical across adapters from the consumer's perspective. No transactions required — the CAS-predicate is a single statement in every engine.

**MySQL gotcha:** the literal `version` collides with the `VERSION()` function but the SQL builder quotes the identifier with backticks. Don't write raw SQL that references `version` unquoted.

## Limitations

Documented gaps in v1 — don't rely on these features yet:

1. **Per-item conflict disambiguation in bulk responses.** Bulk PATCH / PUT returns aggregate `{ matchedCount, modifiedCount }`. There is no per-item 207 Multi-Status response. If you need per-row conflict reporting, do the calls one at a time.
2. **Renamed version columns.** A schema declaring `@db.column 'v' @db.column.version revision: int` may not work correctly — `$cas` and `withOptimisticRetry` assume the version field uses its logical name in the row payload. Use the default column name (`version`, or whatever the logical field is named without `@db.column` rename) until a follow-up lands.
3. **External writers bypass auto-bump.** Anything that writes to a versioned row outside the adapter (raw SQL migrations, ETL pipelines, ops scripts, replication catchup) will NOT increment the version. A subsequent `$cas`-protected caller will then succeed against a stale state. Install per-engine DB triggers if you need defense-in-depth — atscript-db does not install them.
4. **No timestamp-based, hash-based, or per-field versioning.** Integer row-version only.
5. **No pessimistic locking** (`SELECT FOR UPDATE`). Separate concept; not in scope.

## See also

- [annotations.md § `@db.column.version`](./annotations.md#dbcolumnversion--optimistic-concurrency) — annotation reference.
- [crud.md § Optimistic concurrency](./crud.md#optimistic-concurrency) — SDK call shapes.
- [moost-db.md § Optimistic concurrency over HTTP](./moost-db.md#optimistic-concurrency-over-http) — controller behavior + 409 body shape.
- [patch.md § Field ops](./patch.md#field-ops) — composing `$cas` with `$inc` / `$mul`.
- [validation.md § Version column](./validation.md#version-column) — direct-write rejection.
- [testing.md § Testing OCC](./testing.md#testing-occ) — CAS hit/miss test patterns.
