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
- Defaults from `@db.default*` are applied when the adapter doesn't do so natively (see `base-adapter.ts:nativeDefaultFns`).
- Nested writes (insert / replace / patch into `@db.rel.from` arrays) are rejected unless `@db.depth.limit N` is set for the right depth; `@db.depth.limit 0` rejects any nesting with HTTP 400.
- **`opts?: { maxDepth?: number }`** on `insertMany` / `bulkUpdate` / `bulkReplace` caps recursive nested-write depth at this call (default `3`). `@db.depth.limit` is the server-side acceptance gate; `maxDepth` is the in-call recursion budget for the table's own batch processing.

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

Server validates with mode `'replace'` — all non-optional non-defaulted fields must be present. Replace is FULL — omitted optional fields end up `null` in storage.

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
- Field ops `$inc/$dec/$mul` atomic at DB level (see `patch.md`).
- Array ops `$insert/$upsert/$update/$remove/$replace` decompose per-adapter.

## Optimistic concurrency

Tables annotated with `@db.column.version` get first-class OCC. The adapter auto-bumps the version on every successful write. Opt into conflict detection per call via the inline `$cas` operator on `updateOne` / `replaceOne` / `bulkUpdate`:

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

- **Auto-bump is mandatory.** Every write to a versioned table bumps the version column, whether or not `$cas` was supplied. The bump is not opt-in.
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
- Adapters that don't implement `_beginTransaction` run `fn` in a no-op context.
- On throw: the adapter rolls back; the original error is re-thrown.

## DbError

Thrown for integrity and query failures. Validation failures throw `ValidatorError` from `@atscript/typescript` — see `validation.md`.

```ts
import { DbError } from "@atscript/db";

try {
  await users.insertOne({ authorId: 999 });
} catch (e) {
  if (e instanceof DbError) {
    e.code; // 'CONFLICT' | 'FK_VIOLATION' | 'NOT_FOUND' | 'CASCADE_CYCLE' | 'INVALID_QUERY' | 'DEPTH_EXCEEDED'
    e.errors; // Array<{ path: string; message: string }>
  }
}
```

Moost controllers (`moost-db`) map `CONFLICT → 409` and every other `DbError` code → 400. `ValidatorError → 400`. Body shape: `{ statusCode, message, errors }`.

## Search

```ts
await users.search('alice', { filter: { active: true } }, 'main_idx')
await users.vectorSearch([0.1, 0.2, ...], { controls: { $limit: 10 } })
await users.searchWithCount(text, q, indexName)         // { data, count }
await users.vectorSearchWithCount(vector, q)            // { data, count }
```

Guard with `users.isSearchable()` / `users.isVectorSearchable()` — adapters without override throw.
