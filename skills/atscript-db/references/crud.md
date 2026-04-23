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
```

- Server validates with mode `'insert'` (optional + required, plus `@db.rel.FK` existence check via the application integrity layer or native DB constraint).
- Defaults from `@db.default*` are applied when the adapter doesn't do so natively (see `base-adapter.ts:nativeDefaultFns`).
- Nested inserts (writes to `@db.rel.from` / `@db.rel.via` arrays) are rejected unless `@db.deep.insert N` is set for the right depth; `@db.deep.insert 0` rejects any nesting with HTTP 400.

## Replaces (full-record)

```ts
await users.replaceOne({ id: 1, name: 'Alice', email: '...' })    // PK required in payload
await users.replaceMany({ role: 'guest' }, { status: 'archived' })// FilterExpr + full record
await users.bulkReplace([{ id: 1, ... }, { id: 2, ... }])
```

Server validates with mode `'replace'` — all non-optional non-defaulted fields must be present.

## Updates / patches

```ts
await users.updateOne({ id: 1, status: "active" }); // PK in payload
await users.updateMany({ status: "active" }, { points: $inc(100) });
await users.bulkUpdate([
  { id: 1, stock: $dec(2) },
  { id: 2, stock: $dec(3) },
]);
```

- Mode `'patch'`: only supplied fields validated (partial).
- Field ops `$inc/$dec/$mul` atomic at DB level (see `patch.md`).
- Array ops `$insert/$upsert/$update/$remove/$replace` decompose per-adapter.

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
