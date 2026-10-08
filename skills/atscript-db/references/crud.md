# crud

Signatures on `AtscriptDbTable`. Narrowing via `$with` / `$select` reshapes the response type.

## Return types

```ts
TDbInsertResult     = { insertedId: unknown }                               // user-supplied PK when present; else DB-generated (rowid, _id, auto-increment)
TDbInsertManyResult = { insertedCount: number; insertedIds: unknown[] }
TDbUpdateResult     = { matchedCount: number; modifiedCount: number }
TDbDeleteResult     = { deletedCount: number }
```

## Inserts

```ts
await users.insertOne({ name: "Alice", email: "a@e.com" });
await users.insertMany([{ name: "A" }, { name: "B" }]);
await users.insertMany(rows, { maxDepth: 5 }); // override nested-write recursion budget
```

- Server validates with mode `'insert'` (optional + required, plus `@db.rel.FK` existence check via the application integrity layer or native DB constraint).
- `undefined` ≡ absent at every plain-object depth (since 0.1.128): pruned before defaults/validation → a defaulted column gets its DEFAULT, an optional column stays absent. `null` ≡ explicit NULL. Array elements are never dropped; class instances (`Date`, `Buffer`, `ObjectId`) untouched.
- Payload types: `DbPatch<Row>` (insert/patch — all keys optional, optional columns accept `null`), `DbRow<Row>` (replace). Defaults pass before validation: static `@db.default 'x'` values on EVERY adapter (since 0.1.128 — also where the DDL carries the same `DEFAULT`; guards/validators see the full row), function defaults (`now`/`uuid`/`increment`) only when not in the adapter's `nativeDefaultFns()`. No public `applyDefaults` — observe / enrich the defaulted rows through a write guard.
- Static defaults are typed per design type (string / string-literal union → raw string; boolean, number, JSON → `JSON.parse` of the literal).
- Nested writes (insert / replace / patch into `@db.rel.from` arrays) are rejected unless `@db.depth.limit N` is set for the right depth; `@db.depth.limit 0` rejects any nesting with HTTP 400.
- **`opts?: { maxDepth?: number; guard?; check? }`** (`TWriteOptions`) on `insertOne/Many` / `updateOne` / `bulkUpdate` / `replaceOne` / `bulkReplace`: `maxDepth` caps recursive nested-write depth at this call (default `3`; `@db.depth.limit` is the server-side acceptance gate, `maxDepth` the in-call recursion budget). `guard(ctx)` (since 0.1.128) runs EXACTLY ONCE inside the table's own transaction after `undefined`-pruning + defaults + validation, before encryption / nested phases, never for nested re-entries: `ctx.action` (`insert|insertMany|replace|replaceMany|update|updateMany`), `ctx.rows` (validated plaintext rows, nav data attached; `$cas` removed on update — mutate in place, re-validated afterwards), `ctx.expectedVersions[i]`, `ctx.current(i)` (lazy memoised pre-image read inside the tx, identified exactly like the write — [primary key first](#id-resolution--one-row-primary-key-first-01143), 0.1.143; `null` without an identifying key, never throws), `ctx.currentAll()` (0.1.143: every pre-image in ONE `findMany`, parallel to `rows`, fills the same memo — reuses indexes `current(i)` read; a later `current(i)` reads nothing), `ctx.filterFor(i)` (0.1.143: the exact filter the write targets row i by — PK, else its unique key, ≤ 1 row — or `null` without a key; what `current(i)` reads by; memoised per index. USING without reads: `count({ $and: [{ $or: filters }, policy] }) === distinct filters`). A throw rolls back and propagates unchanged. `deleteOne(id, { guard, scope? })` (`TDeleteOptions`): `ctx.id`, `ctx.filter` (the exact filter the delete targets, PK first), `ctx.current()`; an id that resolves to no filter → `{ deletedCount: 0 }`, guard not called. `check(ctx)` (0.1.143) → [§ Post-write check](#post-write-check-check-01143). moost-db's `guardWrite` / `guardRemove` / `checkWrite` overrides are these hooks.
- **Skip conflicting rows — `onConflict: "ignore"` (since 0.1.148).** `insertOne(row, { onConflict: "ignore" })` → `{ insertedId?, conflict }`; `insertMany(rows, { onConflict: "ignore" })` → `{ insertedCount, insertedIds, inserted, conflicts }` (`insertedIds` = ids of inserted rows only, dense; `inserted[k]` = input index of `insertedIds[k]`; `conflicts` = skipped input indices, ascending). Skips only uniqueness collisions (PK or any unique index) with stored rows OR an earlier row of the same batch (earlier wins; a key with a NULL/missing component never collides). Validation / NOT NULL / FK / `guard` / `check` errors still throw and roll back; `guard` sees ALL submitted rows, `check` the inserted rows only (once, empty when none). A nested `@db.rel.to` PARENT payload that would create a parent → `INVALID_QUERY` (it would be orphaned), but a TO object naming ONLY the target's key (`{ author: { id } }`) links the existing parent (becomes the FK, existence-checked; a disagreeing own FK value is `INVALID_QUERY`); a conflict reveals the unique value exists (as the default 409 does) — scope uniqueness per tenant with per-tenant unique indexes; FROM children / VIA links are written for inserted rows only; a conflict inside a nested child insert still throws. Never aborts the surrounding transaction. Sequences / increments / SDK defaults of skipped rows are consumed (gaps). Adapter without `insertManyIgnore` → `DbError("ON_CONFLICT_NOT_SUPPORTED")`. Per adapter: SQLite per-row `ON CONFLICT DO NOTHING`; PG one batched `… ON CONFLICT DO NOTHING RETURNING pk + unique cols` per chunk (mapped back by key, exact: every key the input row defines must match, and an ambiguous mapping — keyless rows, normalised NUMERIC/CHAR keys, keys that differ only in letter case (uuid, citext) and non-text keys the server may return in another form — falls back to a per-row SAVEPOINT redo); MySQL ONE optimistic multi-row INSERT per chunk (an all-new batch is one statement); on 1062/1586 one SELECT of the chunk's stored keys, then the survivors in one INSERT (bisected only on a race; a PRIMARY duplicate of a GENERATED id — an exhausted AUTO_INCREMENT — is rethrown, never skipped; with `NO_AUTO_VALUE_ON_ZERO` in the session an explicit 0 key is a value; chunks mixing explicit and generated auto-increment ids go as one statement per kind; never `INSERT IGNORE`); Mongo `ordered:false` + 11000 outside a transaction / key pre-check + ordered insert inside one; memory per-row. HTTP `POST /?$onConflict=ignore` → [moost-db.md](moost-db.md#insert-ignore-and-closing-spaces-01148); client `insert(rows, { onConflict: "ignore" })` → [db-client.md](db-client.md).
- **`insertMany` rows may differ in shape** — each row is written like `insertOne`; a column a row omits gets its DEFAULT/NULL. ≤ 0.1.131 PostgreSQL + MySQL took the column list from row 1 and silently DROPPED every other column for the whole batch (SQLite/Mongo/memory unaffected) — re-check data from heterogeneous batches.

## Replaces (full-record)

```ts
await users.replaceOne({ id: 1, name: 'Alice', email: 'a@e.com', role: 'admin' })    // PK + full record
// replaceMany: filter + FULL replacement record (every non-optional non-defaulted field required)
await users.replaceMany(
  { role: 'guest' },
  { name: 'Archived User', email: 'archived@e.com', role: 'archived', active: false }
)
await users.bulkReplace([{ id: 1, ... }, { id: 2, ... }])
await users.bulkReplace(rows, { maxDepth: 5 })                    // nested-write recursion override
```

Server validates with mode `'replace'` — all non-optional non-defaulted fields must be present. `replaceOne` / `bulkReplace` are FULL — omitted optional fields end up `null` in storage on every adapter (since 0.1.128 the SQL adapters assign every column in their `UPDATE`-based replace — `NULL`, or `DEFAULT` for a column whose function default the engine owns; before, an omitted column silently kept its old value on SQLite/PostgreSQL/MySQL). `replaceMany` is NOT a full replace: on every adapter it is a `$set`-style merge of the given columns on each matched row (SQL `UPDATE … SET`, Mongo `updateMany` + `$set`, memory merge) — omitted optional fields KEEP their stored values; versioned tables bump `version` per matched row.

## Updates / patches

```ts
await users.updateOne({ id: 1, status: "active" }); // PK in payload
await users.updateMany({ status: "active" }, { points: $inc(100) });
await users.bulkUpdate([
  { id: 1, stock: $dec(2) },
  { id: 2, stock: $dec(3) },
]);
await users.bulkUpdate(rows, { maxDepth: 5 }); // nested-write recursion override
```

- Mode `'patch'`: only supplied fields validated (partial).
- Field ops `$inc/$dec/$mul` atomic at DB level (see `patch.md`). The operand must be FINITE (0.1.148): `$inc(NaN)` / `$mul(Infinity)` → validation error `Field operation operand must be a finite number`.
- Array ops `$insert/$upsert/$update/$remove/$replace` decompose per-adapter.
- `undefined` value = key not sent (never in the SET list); `null` = SET NULL (optional columns; typed — since 0.1.128 filters on optional columns accept `null` too, see `queries.md § Null values`). Non-merge nested object: undefined optional leaf ≡ omitted (null-filled); merge block: untouched.
- Empty patch (PK only, no `$cas`) → no statement, `{ matchedCount: 1|0, modifiedCount: 0 }`; PK + `$cas` → versioned touch (executes, bumps) — see `versioning.md`. `updateMany(filter, {})` → count only.
- `touchMany(keys, { require })` (since 0.1.129, versioned tables): batch versioned touch — each key = primary key (composite ok, not a unique index) + version, no payload; `'all'` (default) pre-counts and throws `CasMismatchError` (`CAS_MISMATCH`, 409) on a stale/missing row, bumps in ≤ 500-key `$or` chunks inside one transaction; `'any'` bumps what matches. Not on the REST surface. See `versioning.md § Batch touch`.
- Nested relation payloads (TO object, FROM/VIA operators) only ever touch rows related to the record being written, and run only for rows the main write matched — rules + error codes in [relations.md § Nested-write integrity](relations.md#nested-write-integrity-01143). A TO patch on a missing row returns `{ matchedCount: 0, modifiedCount: 0 }` (≤ 0.1.142 threw `source record not found`).

## Post-write check (`check`, 0.1.143)

Row-level WITH CHECK. The guard sees rows BEFORE the write; `check` sees what was WRITTEN, with the database's own filter semantics. Option on `insertOne/Many`, `replaceOne` / `bulkReplace`, `updateOne` / `bulkUpdate` — not deletes, not `updateMany` / `replaceMany`.

```ts
import type { TDbWriteCheckContext } from "@atscript/db";

const withCheck = async (ctx: TDbWriteCheckContext) => {
  if (ctx.filters.length === 0) return;
  const inScope = await ctx.count({
    $and: [{ $or: [...ctx.filters] }, { tenant: currentTenant() }],
  });
  if (inScope !== ctx.filters.length) throw new Error("row outside your tenant"); // rolls back
};
await tasks.updateOne({ id: 1, tenant: "other" }, { check: withCheck }); // throws, nothing written
```

| #   | Rule                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Called ONCE per top-level call, inside the table's tx, AFTER the main write and every nested-relation phase. Never for nested re-entries.                                                                                                                                                                                                |
| 2   | `ctx.action` = the guard's enum (`bulkReplace` → `replaceMany`, `bulkUpdate` → `updateMany`). `ctx.filters` = one exact PK filter per written row, de-duplicated: inserted rows by their resulting PK (auto-increment / generated ids included), updated / replaced rows by the targeted row's PK; rows that matched nothing are absent. |
| 3   | `ctx.count(filter)` counts inside the same tx. A throw rolls back and propagates unchanged.                                                                                                                                                                                                                                              |
| 4   | `ctx.transactional === false` (pass-through tx: memory adapter, standalone Mongo) → the write is already durable; the throw rolls nothing back. Validate BEFORE the write (guard) where a hard guarantee is needed.                                                                                                                      |
| 5   | Nested re-entries on related tables get neither `guard`, `check` nor `isFieldVisible` — a permission layer rejects nested payloads up front.                                                                                                                                                                                             |

## Optimistic concurrency

Tables annotated with `@db.column.version` get first-class OCC. The adapter auto-bumps the version on every successful write (except [version-exempt](versioning.md) patches). Opt into conflict detection per call via the inline `$cas` operator on `updateOne` / `replaceOne` / `bulkUpdate`:

```ts
const row = await users.findOne({ filter: { id } });

const result = await users.updateOne({
  id,
  status: "active",
  $cas: { version: row.version }, // opt-in CAS predicate
});

if (result.matchedCount === 0) {
  // Row missing OR another writer bumped the version. Retry or surface 409.
}
```

Locked behaviors:

- **Auto-bump is mandatory.** Every write to a versioned table bumps the version column, whether or not `$cas` was supplied. The bump is not opt-in — except [version-exempt](versioning.md) patches (0.1.150).
- **CAS predicate is opt-in via `$cas`.** Without it, writes apply as last-write-wins (today's semantics).
- **`matchedCount === 0` is the stale-detection signal.** No exception is thrown on mismatch. Treat "row missing" and "version mismatch" the same in retry loops, or follow up with `findOne` to disambiguate.
- **`updateMany` never CAS-checks.** Passing `$cas` to `updateMany` throws. Use `bulkUpdate` with per-item `$cas` for per-row version locking.
- **Direct writes to the version column throw `DbError("VERSION_COLUMN_WRITE")`.** Plain SET, `$inc`, or `$mul` targeting the version field is rejected at the patch-decomposer layer on every write path.
- **Composition with `$inc` / `$mul` is atomic.** `{ counter: $inc(1), $cas: { version: N } }` runs as one statement (`SET counter = counter + 1, version = version + 1 WHERE id = ? AND version = N`).

Per-row CAS in bulk:

```ts
await users.bulkUpdate([
  { id: "u1", status: "active", $cas: { version: 7 } }, // applies if v=7
  { id: "u2", status: "active", $cas: { version: 3 } }, // skipped if stale
  { id: "u3", status: "active" }, // no $cas → wins
]);
```

`replaceOne` accepts `$cas` with identical semantics. `bulkReplace` threads `$cas` per item.

For read-modify-write loops use `withOptimisticRetry` ([versioning.md](versioning.md#withoptimisticretry--the-retry-helper)) — it handles the re-read + retry + `CasExhaustedError` story. Full reference: [versioning.md](versioning.md).

## Deletes

```ts
await users.deleteOne(42); // scalar id
await users.deleteOne({ orderId: 1, productId: 2 }); // composite PK
await users.deleteMany({ status: "archived" }); // FilterExpr
```

`deleteOne` triggers referential actions (cascade/setNull/restrict) via the integrity strategy.

Per-request hidden unique keys (since 0.1.134): `deleteOne(id, { isFieldVisible })`, `updateOne/bulkUpdate/replaceOne/bulkReplace(rows, { isFieldVisible })`, `resolveIdFilter(id, { isFieldVisible })`, `identificationsVisibleTo(isFieldVisible)` — a unique index over a field failing the predicate is ignored as if it did not exist (no existence oracle). PK / `preferredId` / `@meta.id` always count as visible. Writes apply it only to the top-level PK-less unique-index fallback, never to nested relation writes. moost-db passes it from `hasField` automatically.

## Id resolution — one row, primary key first (0.1.143)

A scalar can fit several identifications (string PK next to a string unique `slug`: `"abc"` = one row's `id` AND another's `slug`). ≤ 0.1.142 writes `$or`-ed them → `deleteOne("abc")` could delete the slug namesake. Now every id addresses exactly ONE row.

| API                                                                                                 | Resolves to                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveRowFilter(id, { scope?, isFieldVisible? })`                                                 | `Promise<FilterExpr \| null>` — PK tried first, then each unique index; the first that matches a row wins, returned as that row's exact PK filter. Object id with the complete PK → PK alone (no read). Nothing matches → the first identification (matches nothing). `null` = the id fits no identification. |
| `findOneByRow(id, { scope?, controls?, isFieldVisible? })` (0.1.143)                                | `Promise<row \| null>` — the row `resolveRowFilter` addresses, read with `controls`, `null` when missing or outside `scope`. One step: identifications probed in order with the caller's controls (no resolve-then-read).                                                                                     |
| `resolveIdFilter(id, { isFieldVisible? })`                                                          | Sync `$or` of every compatible identification — CAN match several rows. Never address a write or a single-row read with it.                                                                                                                                                                                   |
| `recordFilter(payload, { isFieldVisible? })` (0.1.143, tables)                                      | The filter `updateOne` / `replaceOne` of `payload` target (PK when complete, else a unique index) — explain a write's outcome (e.g. a CAS 0-match) against exactly the row it addressed. Throws `NOT_FOUND` without identifying fields.                                                                       |
| `findById`, `deleteOne` (pinned inside its tx), write guard `current(i)`, remove guard `ctx.filter` | `resolveRowFilter` semantics.                                                                                                                                                                                                                                                                                 |

moost-db: `GET /one`, `DELETE` and action ids pass through the controller's `resolveRowIds` (0.1.148) before this resolution — see [moost-db.md](moost-db.md#resolverowids--stale--alias-ids-01148). `resolveRowFilter` on the controller is NOT that seam (`/one` reads through `findOneByRow`).

`scope` (`TRowResolveOptions`, a row overlay such as a tenant filter): only in-scope rows count while identifications are tried — an out-of-scope row never shadows an in-scope one. `resolveRowFilter` does NOT filter its result: AND the scope on before reading. `deleteOne(id, { scope })` also scopes the delete itself (out-of-scope row → `{ deletedCount: 0 }`, guard `current()` → `null`).

```ts
const scope = { tenant: currentTenant() };
const row = await slugs.findOneByRow("abc", { scope, controls: { $select: ["id", "title"] } });
await slugs.deleteOne("abc", { scope });
```

moost-db passes `transformOne({})` as this scope for `/one`, `DELETE` and action ids → [moost-db.md § Hooks](moost-db.md#hooks-override-on-subclass).

## Reads

```ts
await users.findOne({ filter: { id: 1 } });
await users.findOne({ filter: { id: 1 }, controls: { $with: [{ name: "posts" }] } });
await users.findMany({
  filter: { active: true },
  controls: { $sort: { createdAt: -1 }, $limit: 20, $select: ["id", "name"] },
});
await users.count({ filter: { active: true } });
await users.findManyWithCount(q); // { data, count } — adapter may optimise to one query
```

`findOne` returns the row or `null`. Nav props are stripped from the response type unless requested via `$with`.

## Transactions

```ts
await users.withTransaction(async () => {
  await users.insertOne({ name: "A" });
  await posts.insertOne({ authorId: 1, body: "..." }); // nested call reuses the same tx
});
```

- Uses `AsyncLocalStorage` so peer tables in the same space participate in the outer tx automatically.
- Adapters that don't implement `_beginTransaction` run `fn` in a no-op context (memory adapter: NO rollback).
- On throw: the adapter rolls back; the original error is re-thrown.
- The tx state is branded by connection (driver / pool / client; since 0.1.128): adapters over the same connection join one transaction; a nested `withTransaction` on ANOTHER family or connection (Mongo inside SQLite, a second pool, …) opens its OWN transaction on top — the outer family's statements inside it still belong to the outer tx; bare statements of another family run autocommit. Never atomic across engines.
- Schema sync is not one transaction: each step takes its own statement group (on SQLite its own gate hold), so run `syncSchema` before serving traffic.
- SQLite (since 0.1.128): transactions are serialised per driver (`BEGIN IMMEDIATE` behind a FIFO gate; plain statements wait for COMMIT). Never await external I/O inside; see `adapters-sqlite.md`.
- In `moost-db` controllers use `this.withTransaction(fn)` / override `guardWrite` — see `moost-db.md`.

## DbError

Thrown for integrity and query failures. Validation failures throw `ValidatorError` from `@atscript/typescript` — see `validation.md`.

```ts
import { DbError } from "@atscript/db";

try {
  await users.insertOne({ authorId: 999 });
} catch (e) {
  if (e instanceof DbError) {
    e.code; // 'CONFLICT' | 'FK_VIOLATION' | 'NOT_FOUND' | 'CASCADE_CYCLE' | 'INVALID_QUERY' | 'DEPTH_EXCEEDED' | …
    e.errors; // Array<{ path: string; message: string }>
  }
}
```

Other codes: `SPACE_CLOSED` (0.1.148 — the `DbSpace` was closed, see [getting-started.md](getting-started.md#closing-a-space-01148); moost-db 503), `ON_CONFLICT_NOT_SUPPORTED` (0.1.148, 400). `CONFLICT` = unique violation OR (0.1.143) a nested write naming a related row outside the record's relation — see [relations.md § Nested-write integrity](relations.md#nested-write-integrity-01143). Moost controllers (`moost-db`) map `CONFLICT → 409` and every other `DbError` code → 400. `ValidatorError → 400`. Body shape: `{ statusCode, message, errors }`.

## Search

```ts
await users.search('alice', { filter: { active: true } }, 'main_idx')
await users.vectorSearch([0.1, 0.2, ...], { controls: { $limit: 10 } })
await users.searchWithCount(text, q, indexName)         // { data, count }
await users.vectorSearchWithCount(vector, q)            // { data, count }
```

Guard with `users.isSearchable()` / `users.isVectorSearchable()` — adapters without override throw.

`controls.$select` on `vectorSearch*` / `geoSearch*` projects exactly like `findMany` (inclusion + exclusion, nested paths) on every adapter; ≤ 0.1.142 the SQL adapters returned every column (incl. `@db.writeOnly`, also over HTTP `$vector` / `/geo`).

`isSearchable()` answers for TEXT search only. `getSearchIndexes()` lists vector indexes alongside text ones (it feeds the index picker), but a vector index answers `vectorSearch()` and nothing else, so a table whose only search declaration is `@db.search.vector` reports `isSearchable() === false` and rejects `search()` / `searchWithCount()` / a grouped `$search` with `DbError("INVALID_QUERY", [{ path: "$search" }])`. (since 0.1.131). `vectorSearch()` never took this gate and is unaffected.
