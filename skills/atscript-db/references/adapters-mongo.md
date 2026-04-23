# adapters-mongo

`@atscript/db-mongo` — via `mongodb ^6`. No SQL layer; queries compile to aggregation pipelines, patches to `$set`-stage pipelines.

## Wiring

```ts
import { DbSpace } from "@atscript/db";
import { MongoAdapter } from "@atscript/db-mongo";
import { MongoClient } from "mongodb";

const client = new MongoClient("mongodb://localhost:27017/app");
await client.connect();
const db = new DbSpace(() => new MongoAdapter(client.db(), client));
```

Second `MongoAdapter` arg (the client) is only required for transactions — `session.withTransaction()` needs the client handle, not just the `Db`.

## Register the plugin

```ts
import { MongoPlugin } from "@atscript/db-mongo/plugin"; // subpath, not the package root
plugins: [ts(), dbPlugin(), MongoPlugin()]; // unlocks @db.mongo.*, mongo.objectId, mongo.vector
```

## Capabilities

| Capability              | Notes                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transactions            | `withTransaction(fn)` uses `session.withTransaction()` — requires replica-set (Atlas or local replica).                                                                        |
| Native FKs              | No (`supportsNativeForeignKeys: false`) — cascade / setNull run in the application integrity strategy.                                                                         |
| `supportsNestedObjects` | **Yes** — nested objects stored as-is, not flattened.                                                                                                                          |
| Native patches          | Yes (`supportsNativePatch: true`). `CollectionPatcher` emits `$set` aggregation pipelines.                                                                                     |
| Native relation loading | Yes (`supportsNativeRelations: true`) — `$lookup` based.                                                                                                                       |
| Full-text search        | **Atlas Search** (`$search` stage) via `@db.mongo.search.static` + `@db.mongo.search.text`. Legacy `text` indexes via `@db.mongo.index.text` (weight) or `@db.index.fulltext`. |
| Vector search           | **Atlas Search** (`$vectorSearch` stage) via `@db.search.vector` or `@db.mongo.search.vector`.                                                                                 |
| Column diffing          | N/A — schemaless. `getExistingColumns` is not implemented; sync uses `tableExists()` + snapshot-driven index diffs.                                                            |
| JSON / nested           | Native — `@db.json` is a no-op (store as Document).                                                                                                                            |

## Managed index prefix

**All indexes created by `syncIndexes()` start with `atscript__`.** Indexes not matching the prefix are left alone. Indexes matching the prefix that aren't in the desired set are dropped on drift.

Implication: do not name a consumer-authored index with the `atscript__` prefix.

## `@db.mongo.*` annotations

See [mongo-annotations.md](mongo-annotations.md) for the full table.

## Primitives

| Primitive        | Constraint                               |
| ---------------- | ---------------------------------------- |
| `mongo.objectId` | `string` matching `/^[a-fA-F0-9]{24}$/`. |
| `mongo.vector`   | `number[]`.                              |

On `insertOne`/`updateOne`/`findOne` with a `mongo.objectId`-typed PK, the adapter's `prepareId()` converts `string` to `ObjectId` before the driver call, and returns the user-supplied string as `insertedId`.

## Atlas Search

Text:

```atscript
@db.table 'articles'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 1, 'main'
interface Article {
    @meta.id _id: mongo.objectId
    @db.mongo.search.text 'lucene.english', 'main'
    title: string
    @db.mongo.search.text 'lucene.english', 'main'
    body: string
}
```

`search('quick brown', query, 'main')` uses `$search: { index: 'main', text: { query: 'quick brown', path: ... } }` as the first pipeline stage.

Vector:

```atscript
@db.search.vector 1536, 'cosine', 'doc_vec'
embedding: mongo.vector
```

`vectorSearch(vec, query, 'doc_vec')` uses `$vectorSearch`.

## Patch / CollectionPatcher

Every `updateOne`/`updateMany` payload → a single aggregation stage:

```
[ { $set: <pipeline-object built from patch> } ]
```

Array operations (`$insert`, `$upsert`, `$update`, `$remove`, `$replace`) map to `$concatArrays` / `$setUnion` / `$setDifference` / `$filter` / `$map` combinations — one round-trip per call regardless of array-op count.

`@db.mongo.array.uniqueItems` turns `$insert` into `$setUnion` so the array stays deduped.

## Transactions

```ts
await users.withTransaction(async () => {
  await users.insertOne({ _id: "..." });
  await posts.insertOne({ authorId: "..." });
});
```

Requires a replica set. The adapter uses `session.withTransaction()` internally and propagates the session via `AsyncLocalStorage` to nested tables in the same space.

## Known limits

- Referential actions (`@db.rel.onDelete 'cascade'` etc.) are application-level; concurrent writes can race.
- Managed full-text `text` indexes are mutually exclusive per collection — use Atlas Search for multi-index scenarios.
- `ensureTable()` is a no-op unless `@db.mongo.capped` is set (then `createCollection` with capped options).
