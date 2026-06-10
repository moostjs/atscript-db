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

> The `mongodb` driver has optional peer deps (e.g. `aws4` for `MONGODB-AWS`, `kerberos`, `mongodb-client-encryption`) that pnpm won't install. If you hit `MongoMissingDependencyError` only in prod, see the [mongodb optional dependencies docs](https://www.mongodb.com/docs/drivers/node/current/get-started/installation/) — this is not an atscript-db concern.

## Register the plugin

```ts
import { MongoPlugin } from "@atscript/db-mongo"; // also available at the /plugin subpath
plugins: [ts(), dbPlugin(), MongoPlugin()]; // unlocks @db.mongo.*, mongo.objectId
```

## Capabilities

| Capability              | Notes                                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transactions            | `withTransaction(fn)` uses `session.withTransaction()` — requires replica-set (Atlas or local replica).                                                                                                     |
| Native FKs              | No (`supportsNativeForeignKeys: false`) — cascade / setNull run in the application integrity strategy.                                                                                                      |
| `supportsNestedObjects` | **Yes** — nested objects stored as-is, not flattened.                                                                                                                                                       |
| Native patches          | Yes (`supportsNativePatch: true`). `CollectionPatcher` emits `$set` aggregation pipelines.                                                                                                                  |
| Native relation loading | Yes (`supportsNativeRelations: true`) — `$lookup` based.                                                                                                                                                    |
| Full-text search        | **Atlas Search** (`$search` stage) via `@db.mongo.search.static` + `@db.mongo.search.text` — Atlas only. Generic `@db.index.fulltext` → classic `text` index queried via `$text` — works on any deployment. |
| Vector search           | **Atlas Search** (`$vectorSearch` stage) via `@db.search.vector` (generic, core annotation).                                                                                                                |
| Column diffing          | N/A — schemaless. `getExistingColumns` is not implemented; sync uses `tableExists()` + snapshot-driven index diffs.                                                                                         |
| JSON / nested           | Native — `@db.json` is a no-op (store as Document).                                                                                                                                                         |

## Managed index prefix

**All indexes created by `syncIndexes()` start with `atscript__`.** Indexes not matching the prefix are left alone. Indexes matching the prefix that aren't in the desired set are dropped on drift.

Implication: do not name a consumer-authored index with the `atscript__` prefix.

## Unique indexes on optional fields are partial

A `@db.index.unique` that includes an optional field is emitted with a `partialFilterExpression` restricting it to documents where the optional field is present — many docs may lack the field while present values stay unique (matches SQL `NULLS DISTINCT`). Composite unique: a doc is exempt as soon as any optional indexed field is missing. Changing a field's optionality changes the filter → index drop+recreate on next sync.

## `@db.mongo.*` annotations

See [mongo-annotations.md](mongo-annotations.md) for the full table.

Removed (use generic core annotations instead):

| Removed                       | Replaced by                       |
| ----------------------------- | --------------------------------- |
| `@db.mongo.index.text`        | `@db.index.fulltext`              |
| `@db.mongo.search.vector`     | `@db.search.vector`               |
| `@db.mongo.search.filter`     | `@db.search.filter`               |
| `@db.mongo.patch.strategy`    | `@db.patch.strategy`              |
| `@db.mongo.array.uniqueItems` | `@expect.array.uniqueItems`       |
| `@db.mongo.autoIndexes`       | — (explicit `syncIndexes()` only) |
| `@mongo.index.plain`          | `@db.index.plain`                 |
| `@mongo.index.unique`         | `@db.index.unique`                |

Capped collections:

| Annotation         | Args                         | Effect                                                                                                    |
| ------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@db.mongo.capped` | `size: number, max?: number` | Creates a capped collection at `ensureTable()`. `size` = bytes. Resize requires `@db.sync.method 'drop'`. |

## Primitives

| Primitive        | Constraint                               |
| ---------------- | ---------------------------------------- |
| `mongo.objectId` | `string` matching `/^[a-fA-F0-9]{24}$/`. |

The Mongo plugin provides only `mongo.objectId`. Vector fields use the core `db.vector` primitive (from `dbPlugin()`), not a Mongo-specific one.

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

`search('quick brown', query, 'main')` emits an Atlas `$search` first stage. The operator shape depends on the index's fields + `strategy`: a plain `text` operator (word match), an `autocomplete` operator (prefix/typeahead), or a `compound.should` of both. Declared/`$fuzzy` typo tolerance is attached to the operator at query time. For `@db.mongo.search.autocomplete`, `strategy`, query-time `fuzzy`/`$fuzzy`, and the multi-index `$index` variant pattern, see [mongo-annotations.md](./mongo-annotations.md).

Vector:

```atscript
@db.search.vector 1536, 'cosine', 'doc_vec'
embedding: db.vector
```

`vectorSearch(vec, query, 'doc_vec')` uses `$vectorSearch`.

## Patch / CollectionPatcher

Every `updateOne`/`updateMany` patch compiles to a single `[ { $set: <pipeline> } ]` aggregation stage — one round-trip regardless of op count. See [patch.md](patch.md).

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
