# Proposal: Optimistic Concurrency via Row Versioning

**Status:** Draft v2 (decisions locked)
**Author:** mavrik (drafted with Claude)
**Date:** 2026-05-22
**Targets:** `@atscript/db` core + all adapters (`db-sqlite`, `db-postgres`, `db-mysql`, `db-mongo`) + `@atscript/moost-db`

---

## 1. Motivation

Atscript DB today has two atomic primitives — **insert** and **field ops** (`$inc`, `$dec`, `$mul`) via [ops.ts](packages/db/src/ops.ts). Every other write is "last-write-wins": a caller reads a row, computes a patch in JS, and submits it via `updateOne()`. Between read and write there is a race window in which another writer can change the row, and the second writer silently overwrites the first.

This is fine for many fields (display name, profile bio) but unsafe for **state machines with read-modify-write semantics**:

| Use-case                                                                 | Why naive UPDATE is unsafe                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Consuming a single-use credential (backup code, magic-link token)        | Two concurrent consumers can both succeed → credential used twice                      |
| Adding to a JSON-column collection (`mfa.methods[]`, `trustedDevices[]`) | Concurrent appenders read the same array, each writes their own union → one entry lost |
| Confirming an MFA enrollment                                             | Two devices confirming concurrently can mask each other                                |
| Workflow step transitions when stored in a row column                    | State machine can land in an inconsistent state                                        |
| Inventory decrement that has business rules (no go-below-zero)           | `$inc(-1)` is atomic but a rule check on the resulting value is not                    |

The common pattern is "read state, compute next state, write state, fail if state changed under us." That pattern is **optimistic concurrency control (OCC)** with a version number, and it is the de-facto enterprise primitive in every major ORM (Hibernate `@Version`, JPA, EF Core `[Timestamp]`, Doctrine `@Version`, Mongoose `versionKey`, Prisma's `update` with version filter, Sequelize `version: true`).

We propose adding first-class support to `@atscript/db` via a new column-level annotation, an inline `$cas` payload operator, a deterministic mismatch signal, and a thin auto-lift layer in `@atscript/moost-db` so REST clients get OCC seamlessly — no changes to existing behavior unless callers opt in.

---

## 2. Design at a glance

**Annotation** — mark a numeric column as the row's version:

```ts
interface MyTable {
  @db.column.version
  version: int
  // ...other fields
}
```

**Core SDK API** — opt in per call via the inline `$cas` operator:

```ts
const ok = await users.updateOne({
  id,
  status: "active",
  $cas: { version: row.version }, // ← opt-in conflict detection
});
if (ok.matchedCount === 0) {
  // Either the row doesn't exist OR another writer touched it. Caller retries.
}
```

**REST API (via `@atscript/moost-db`)** — clients just round-trip the row. The controller lifts `version` in the body to `$cas` automatically:

```
GET /users/u1
  → { id: "u1", name: "Ada", status: "active", version: 4 }

PUT /users/u1
Body: { name: "Ada Lovelace", status: "active", version: 4 }
  → 200 OK  { ..., version: 5 }       (success — server bumped)
  → 409 Conflict { error: "version_mismatch", currentVersion: 6 }  (someone else won)
  → 404 Not Found                     (row gone)
```

**Behavior** — on every successful update of a versioned row, the adapter **atomically increments the version column by 1** alongside the user's patch. If `$cas` is supplied AND the current row version does not match, the adapter returns `{ matchedCount: 0, modifiedCount: 0 }` without applying any change. The caller treats this as "stale read, retry."

That is the whole feature. The rest of this document is the why-not-just-X discussion, edge cases, and per-adapter implementation notes.

---

## 3. Why this fits Atscript DB

1. **Atscript's `.as` schemas are the source of truth.** A single `@db.column.version` annotation is more declarative than every consumer adding "version: int" + remembering to bump it. The schema sync layer already handles column additions (see [packages/db/src/sync.ts](packages/db/src/sync.ts)) — adding a new annotation slots in.
2. **The adapter contract already returns `{ matchedCount, modifiedCount }`** ([packages/db/src/types.ts:189-192](packages/db/src/types.ts#L189-L192)). CAS-mismatch maps cleanly to `matchedCount === 0` — no new error type required for callers willing to treat it like "not found."
3. **Field ops set the precedent.** The codebase already pre-separates atomic numeric ops from regular SET data ([packages/db/src/ops.ts:116-151](packages/db/src/ops.ts#L116-L151)). Version increment is the same shape as `$inc` — adapters that already support `inc` get version increment "almost free." `$cas` lives in the same payload-level operator family.
4. **One feature, all adapters.** Every backend already in tree supports the underlying primitive: SQL adapters do `UPDATE ... SET ... WHERE pk=? AND version=?` natively; Mongo uses `findOneAndUpdate({ _id, version }, { $set: ..., $inc: { version: 1 } })`. No adapter needs a new dependency.

---

## 4. Detailed API

### 4.1 The annotation

```typescript
// packages/db/src/atscript.d.ts — additions to AtscriptAnnotations
"db.column.version": boolean
```

Constraints (enforced at table compile time):

- **At most one** version column per table. Multiple versioned columns make no semantic sense and would require composite CAS logic.
- The annotated field must resolve to a SQL `INTEGER` (or Mongo `Number`). String/timestamp versioning is a separate proposal (§10).
- The field is **server-managed**: the adapter sets it on insert (default `0`) and increments it on every update. Callers MAY read it (and SHOULD, in order to pass `$cas`) but MUST NOT write it directly — direct writes (as plain SET, `$inc`, or `$mul`) are rejected at the patch-decomposer layer with a clear error.
- The annotation is **boolean** only. Column renaming uses the existing `@db.column.renamed` annotation. No double-duty.

### 4.2 The `$cas` operator

`$cas` is a payload-level operator (top-level in the payload, sibling to plain SET fields and `$inc`/`$mul` field ops):

```typescript
await users.updateOne({
  id,
  status: "active",
  backupCodes: row.backupCodes.filter((h) => h !== usedHash),
  $cas: { version: row.version },
});
```

The map shape (`{ version: N }`) is forward-compatible if multi-field CAS is ever added — for v1 it has exactly one entry, keyed by the table's version column name.

**Bulk threading.** Each payload in `bulkUpdate` carries its own `$cas`:

```typescript
await users.bulkUpdate([
  { id: "u1", status: "active", $cas: { version: 7 } },
  { id: "u2", status: "active", $cas: { version: 3 } },
]);
```

Rows with matching versions are updated; rows that mismatch (or don't exist) are silently skipped. `modifiedCount` reflects how many actually applied. This is the version-locked batch primitive.

**No `$cas` on `updateMany`.** `updateMany(filter, data)` always writes through, auto-bumping the version but never checking it. A single `expectedVersion` cannot sensibly match N rows with different versions; the per-row case belongs in `bulkUpdate`.

### 4.3 Adapter-level API extension

`BaseAdapter.updateOne` ([packages/db/src/base-adapter.ts:611-615](packages/db/src/base-adapter.ts#L611-L615)) signature becomes:

```typescript
abstract updateOne(
  filter: FilterExpr,
  data: Record<string, unknown>,
  ops?: TFieldOps,
  expectedVersion?: number,   // ← new
): Promise<TDbUpdateResult>
```

The adapter knows the version column name from `this._table` metadata — no need to thread it through the call.

The version-bump itself is **implicit and mandatory**: when the table metadata declares a version column, the adapter is responsible for adding `version = version + 1` (via the same machinery as `$inc`) to every UPDATE, regardless of whether `expectedVersion` is supplied. This is the crucial property that makes the feature actually work — if the version column doesn't auto-increment, OCC silently degrades to no protection.

`bulkUpdate` adapters thread `expectedVersion` per item (extracted from each payload's `$cas` before adapter dispatch).

### 4.4 Mismatch contract

When `expectedVersion` is supplied and the stored row's version differs:

- `updateOne` returns `{ matchedCount: 0, modifiedCount: 0 }`. No write occurs. No error is thrown.
- `bulkUpdate` returns `{ matchedCount: N, modifiedCount: N }` where `N` counts only rows that matched both their filter AND their per-item version predicate.
- `replaceOne` (when called with `$cas`) follows the same semantics as `updateOne`.
- The caller distinguishes "row missing" from "version mismatch" with an extra `findOne` if it matters. For the dominant use-case (retry-on-conflict), they don't need to — both states warrant the same response.

Rationale for the no-throw choice: throwing creates an asymmetry where every retry path needs `try/catch` instead of a clean `if (!result.matchedCount)`. The Mongo / EF Core ecosystems both went through "exception-on-mismatch" eras and largely walked it back.

### 4.5 Rejection of direct writes

The patch decomposer ([packages/db/src/patch/patch-decomposer.ts](packages/db/src/patch/patch-decomposer.ts)) is the single point of enforcement. In the same pass that strips `$inc`/`$mul` field ops, it:

1. Extracts `$cas` from the top-level payload and surfaces it as `expectedVersion` to the adapter call.
2. Rejects any reference to the version column as a SET key, or as the target of `$inc`/`$mul`, with `DbError("Cannot write to version column directly; omit it or use $cas")`.

This keeps the enforcement in one place and ensures every write path (`updateOne`, `updateMany`, `replaceOne`, `bulkUpdate`, `bulkReplace`) inherits the same rule for free.

### 4.6 Default version on insert

Versioned columns get implicit `default 0` semantics — analogous to existing `@db.default.increment`. Schema sync materializes this as `NOT NULL DEFAULT 0` in SQL DDL (which makes ALTER TABLE backfills automatic at column-add time); Mongo writers fill in `version: 0` at insert time when missing.

---

## 5. Adapter implementation notes

### 5.1 SQL adapters (sqlite / postgres / mysql)

The SQL builder in [packages/db-sql-tools](packages/db-sql-tools) already composes UPDATE statements. Two additions:

1. **Always-bump version.** Before SET-clause generation, if the table has a versioned column, inject `<version_col> = <version_col> + 1` into the SET list (via the same `inc` op machinery already used for `$inc`).
2. **CAS predicate.** If `expectedVersion` is supplied, append `AND <version_col> = ?` to the WHERE clause.

Both are textual additions to the generated SQL — no new driver capability needed. The `matchedCount` returned by the driver natively reflects the version-predicate filter; the existing code already wires this into `TDbUpdateResult`.

**Performance:** zero overhead vs. today on writes that don't supply `$cas` — the only added clause is `version = version + 1` in SET, which is a single integer addition the DB executes alongside the other column writes.

**Transactions:** none required. The CAS-predicate is a single statement and is atomic by definition in every SQL engine — `UPDATE ... WHERE version=?` either matches or doesn't, no race window.

### 5.2 Mongo adapter

Maps to `updateOne` (or `findOneAndUpdate`):

```javascript
collection.updateOne(
  { _id: id, ...(expectedVersion !== undefined ? { [versionColumn]: expectedVersion } : {}) },
  {
    $set: setData,
    $inc: {
      ...incOps,
      [versionColumn]: 1,
    },
  },
);
```

Same semantics: filter excludes mismatched versions, `$inc` bumps it on success. Mongo's atomicity guarantee for `updateOne` covers this natively.

### 5.3 Schema sync

The sync layer (existing logic in [packages/db/src/sync.ts](packages/db/src/sync.ts)) needs to:

- Detect the `@db.column.version` annotation when comparing `.as` schemas against the live DB.
- For new versioned columns added to an existing table: emit DDL with `NOT NULL DEFAULT 0` so the engine backfills existing rows automatically during ALTER TABLE.
- Reject schema definitions with more than one version column per table (compile-time check, ideally; sync-time check as fallback).

The schema hash ([packages/db/src/schema/schema-hash.ts](packages/db/src/schema/schema-hash.ts)) is computed from DDL-affecting properties. Adding/removing the `@db.column.version` annotation on an _existing_ column without changing the column's DDL must not be treated as drift requiring migration.

### 5.4 External writers — known limitation

Any process that writes to a versioned row outside the adapter (raw SQL migrations, ETL pipelines, ops scripts, replication catchup) will **not** bump the version column. A subsequent CAS-protected caller will then succeed against a stale state without knowing. This is a known limitation of the application-layer approach.

Consumers that need to defend against this should install a per-engine database trigger on the versioned table that auto-bumps `version` on every UPDATE — atscript-db does not install such triggers in v1. This is documented; not enforced.

---

## 6. moost-db integration (auto-CAS for REST clients)

The core SDK is explicit on purpose (`$cas` must be present in the payload). `@atscript/moost-db` adds a thin compatibility layer so HTTP clients get OCC by simply round-tripping the row.

### 6.1 Table meta

The table meta exposed to clients gains one top-level pointer:

```ts
{
  tableName: "users",
  versionColumn: "version",   // ← new, optional; present iff table has @db.column.version
  columns: [...],             // unchanged — the version column appears here like any other int column
}
```

Single pointer, self-describing. The column entry for `version` stays exactly like any other column — no special "hidden" / "readonly" flags. Clients use the pointer to decide what to do:

- **Clients that want CAS:** read the row, send it back as-is. The version field rides along.
- **Clients that don't want CAS:** strip the column named by `versionColumn` from the payload before sending.
- **UI generators:** can choose to render the version column as read-only or hide it by checking `column.name === meta.versionColumn`.

### 6.2 Controller behavior

`AsDbController` and `AsDbReadableController` intercept write payloads on tables that have a `versionColumn`:

1. **If `version` is present in the body:** strip it from SET, lift it to `$cas: { version: N }`, dispatch to the core SDK call.
2. **If `version` is absent:** dispatch the write through with no `$cas` — last-write-wins semantics (client opted out by stripping it).

Policy is **presence-based**, not enforced. No 428 "Precondition Required" gate. If you wanted CAS you'd include the field; if you didn't, you'd strip it. This makes adoption seamless and explicit at the same time.

### 6.3 Error responses

When the core SDK returns `matchedCount === 0` on a `$cas`-bearing write, the controller disambiguates with a single `findOne(id)`:

- **Row missing** → `404 Not Found`
- **Row present** → `409 Conflict` with body:

```json
{
  "error": "version_mismatch",
  "currentVersion": 6
}
```

The extra `findOne` is paid only on the conflict path, never on the happy path. Clients on `409` know to GET the row again, re-apply their changes, and retry.

### 6.4 Bulk endpoints

Bulk PUT/PATCH endpoints return per-item status (using moost-db's existing batch response shape) — mismatches surface as per-item conflict entries rather than failing the whole batch. Never "fail all on first conflict."

---

## 7. Service-layer ergonomics

Raw CAS works but every consumer writing a retry loop is friction. A small helper (delivered in `@atscript/db` core) covers 90% of cases:

```typescript
import { withOptimisticRetry } from "@atscript/db";

await withOptimisticRetry(
  users,
  { id },
  async (row) => {
    // Pure function: receives current row, returns the patch.
    return { backupCodes: row.backupCodes.filter((h) => h !== usedHash) };
  },
  { maxAttempts: 5 },
);
```

Implementation is ~20 lines: `findOne(filter)` → call mutator → `updateOne` with `$cas: { version: row.version }` → on `matchedCount === 0` retry up to `maxAttempts` → throw `CasExhaustedError` if it loops forever.

The second parameter is a **filter** (not just an `id`) so composite-key and non-id tables work without contortion.

This helper is optional sugar; the raw API is fine for callers who want explicit control over the retry policy (exponential backoff, jitter, custom failure handling).

---

## 8. Migration story for existing tables

The feature is **opt-in per table** via annotation. Tables without the annotation behave identically to today. Adopting the feature on an existing table:

1. Add `@db.column.version version: int` to the `.as` file.
2. Run schema sync — column is added with `NOT NULL DEFAULT 0`, existing rows backfilled.
3. Existing call sites that don't pass `$cas` continue to work — they just always-win against concurrent writers (today's behavior). Adopt CAS at sites that need it.

No breaking changes. No data migration beyond the one column addition.

---

## 9. Edge cases & gotchas

**9.1 Field ops + CAS.** A caller can mix `$inc` field ops and `$cas` — the adapter applies both atomically. Internally the SET clause looks like `SET counter = counter + 5, version = version + 1` and the WHERE has `AND version = ?`. Single statement, single atomic action.

**9.2 Replace operations.** `replaceOne` supports `$cas` with the same semantics as `updateOne`: predicate filters by version, bump on success.

**9.3 Counter overflow.** `int32` saturates after ~2.1B updates. For tables that turn over that often, support `int64` via existing `@db.column.precision` semantics. Default `int32` is plenty for nearly every realistic scenario (2.1B writes to a single row is ~70 years of one write per second).

**9.4 Server-managed field exposure.** The version column appears in `findOne`/`findMany` results like any other column. The patch decomposer rejects writes to it (as plain SET, `$inc`, or `$mul`) with a clear error. The moost-db controller treats `version` in a write body as a `$cas` directive rather than a SET (per §6.2), so REST clients never trip the rejection.

**9.5 JSON column updates.** Patch decomposition ([packages/db/src/patch](packages/db/src/patch)) for `db.json` columns already handles operator semantics inside JSON. CAS works at the row level — JSON sub-document operators are independent. The version column lives outside the JSON envelope.

**9.6 External-writer hazard.** See §5.4 — direct DB writes bypass the auto-bump. Documented limitation; trigger-based defense is consumer responsibility.

---

## 10. Alternatives considered

**10.1 Timestamp-based versioning.** Use a `lastModified` timestamp instead of an integer version. Reads cleanly (`lastModified > expected` = stale) but suffers from clock-skew on distributed writers and millisecond-collision under high load. Rejected for v1; could be a separate `@db.column.version.timestamp` opt-in later.

**10.2 Hash-based versioning.** Hash the row's content as the "version". Eliminates the column-add migration but pushes hashing into every read+write. Rejected — too expensive and harder to reason about than monotonic integers.

**10.3 Per-field versioning.** Track a version per column rather than per row. Strictly more granular (concurrent edits to disjoint fields succeed). Real ORMs (Hibernate has `@OptimisticLocking(type = DIRTY)`) support this. Rejected for v1 — significantly more complex, and the 80% use-case is "this row's state machine moved on", which is row-level by nature.

**10.4 Pessimistic locking (`SELECT FOR UPDATE`).** Heavier-handed alternative — hold a row lock for the duration of the read-modify-write. Real and useful for some workloads, but it's a separate concept and a separate proposal. OCC is the right starting primitive because it doesn't require any transaction lifecycle on the caller side.

**10.5 `If-Match` header.** REST-idiomatic way to thread an entity tag. Rejected in favor of body-embedded `version` (§6.2) because it's simpler for SPA clients that already round-trip the row, and avoids the controller needing to read headers on every write path. Could be added as an alternative later if needed.

**10.6 `opts.expectedVersion` parameter.** Earlier draft shipped both `$cas` and `opts.expectedVersion`. Rejected — duplicate surface for identical semantics, and `$cas` threads naturally through `bulkUpdate` per-row while `opts.*` cannot. One way to express the intent.

**10.7 `updateMany` per-row CAS.** A single `expectedVersion` can't sensibly match N rows. Earlier draft proposed per-row predicate semantics; rejected as confusing. Per-row CAS is the job of `bulkUpdate` (§4.2).

---

## 11. Implementation phases

**Phase 1 — Core annotation + SQL adapters.**

- `@db.column.version` annotation type + schema-sync support.
- `$cas` extraction in patch decomposer + direct-write rejection.
- `updateOne` / `bulkUpdate` / `replaceOne` adapter signature update.
- `db-sqlite`, `db-postgres`, `db-mysql` implementations (the SQL change is identical across all three).
- Unit + integration tests proving CAS rejection + version auto-increment.

**Phase 2 — Mongo adapter.**

- Same surface, Mongo-native query construction.

**Phase 3 — Ergonomics.**

- `withOptimisticRetry` helper in core.
- Docs page in [docs/guide](docs/guide).

**Phase 4 — moost-db integration.**

- Table meta extension (`versionColumn` pointer).
- Controller auto-lift of `version` → `$cas`.
- 404/409 disambiguation via post-mismatch `findOne`.
- Per-item conflict status in bulk endpoints.

---

## 12. First downstream consumer

The aoothjs auth stack ([packages/user/src/user-service.ts](../../aoothjs/packages/user/src/user-service.ts) in the sibling repo) has a confirmed concurrency bug in `consumeBackupCode` — two parallel `Promise.all` calls with the same code both succeed, violating the single-use guarantee. The regression test was landed as `it.fails` in `user-service.spec.ts` against the in-memory store and reproduces against `@aooth/user`'s atscript-db adapter.

Once this proposal lands:

1. Add `@db.column.version` to the `Users.as` model.
2. Refactor `UserService.consumeBackupCode` to use `withOptimisticRetry`.
3. Flip the `it.fails` regression to a passing test.
4. Cascade the same pattern to `addMfaMethod`, `confirmMfaMethod`, `addTrustedDevice` — three more latent races closed by the same primitive.

This gives the feature an immediate, well-scoped first user with measurable security wins.

---

## 13. Locked decisions

Summary of decisions made during design review:

| #   | Decision                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `version` is **read-only at the SDK** — patch decomposer rejects SET / `$inc` / `$mul` on it.                                   |
| 2   | `updateMany` never CAS-checks. Per-row version locking goes through `bulkUpdate` with per-item `$cas`.                          |
| 3   | Adapter signature gains a single `expectedVersion?: number`. Adapter reads the column name from table metadata.                 |
| 4   | `@db.column.version` annotation is **boolean only**. Column renaming uses the existing `@db.column.renamed`.                    |
| 5   | External-writer hazard is a **documented limitation**, not enforced. DB triggers are consumer responsibility.                   |
| 6   | **`$cas` is the only surface** for opt-in CAS. No `opts.expectedVersion`.                                                       |
| 7   | Rejection of direct writes lives in the **patch decomposer**, alongside `$inc`/`$mul` separation.                               |
| 8   | Default column value is `NOT NULL DEFAULT 0` in SQL DDL — engine backfills automatically.                                       |
| 9   | Table meta exposes a single top-level `versionColumn` string pointer; column entry itself is unchanged.                         |
| 10  | moost-db auto-lifts `version` in body → `$cas`. Presence-based: include for CAS, strip for last-write-wins.                     |
| 11  | Conflict response is **409 with `{ error: "version_mismatch", currentVersion: N }`**. 404 if the row is also gone.              |
| 12  | Default column name is `version`. No `_v` / `__v` / `revision` rename in core; consumers use `@db.column.renamed` if they want. |
