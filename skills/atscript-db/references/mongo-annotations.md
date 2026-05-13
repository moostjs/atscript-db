# mongo-annotations

Requires the Mongo plugin in `atscript.config` (note the `/plugin` subpath):

```ts
import { MongoPlugin } from "@atscript/db-mongo/plugin";
plugins: [ts(), dbPlugin(), MongoPlugin()];
```

## Collection-level

| Annotation                 | Args                                                    | Effect                                                                                             |
| -------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@db.mongo.collection`     | —                                                       | Mark as Mongo collection. Auto-injects `_id: mongo.objectId` when the interface has no `@meta.id`. |
| `@db.mongo.capped`         | `size: number, max?: number`                            | Capped collection (bytes; optional doc limit).                                                     |
| `@db.mongo.search.dynamic` | `analyzer?: string, fuzzy?: number`                     | Dynamic Atlas Search index (indexes all string fields).                                            |
| `@db.mongo.search.static`  | `analyzer?: string, fuzzy?: number, indexName?: string` | Named static Atlas Search index. Combine with `@db.mongo.search.text` on individual fields.        |

## Field-level

| Annotation              | Args                                    | Effect                                              |
| ----------------------- | --------------------------------------- | --------------------------------------------------- |
| `@db.mongo.search.text` | `analyzer?: string, indexName?: string` | Include field in a named static Atlas Search index. |

## Replaced / removed (use the generic core annotation instead)

| Old (no longer exists)        | Use instead                                                |
| ----------------------------- | ---------------------------------------------------------- |
| `@db.mongo.autoIndexes`       | removed — call `syncIndexes()` / `syncSchema()` explicitly |
| `@db.mongo.search.vector`     | `@db.search.vector` (see [annotations.md](annotations.md)) |
| `@db.mongo.search.filter`     | `@db.search.filter`                                        |
| `@db.mongo.patch.strategy`    | `@db.patch.strategy` (see [patch.md](patch.md))            |
| `@db.mongo.array.uniqueItems` | `@expect.array.uniqueItems` (from `@atscript/typescript`)  |
| `@db.mongo.index.text`        | `@db.index.fulltext 'name', weight` (per-field weight)     |
| `@mongo.index.plain`          | `@db.index.plain`                                          |
| `@mongo.index.unique`         | `@db.index.unique`                                         |

## Primitives added by the plugin

| Primitive        | Type constraint                          |
| ---------------- | ---------------------------------------- |
| `mongo.objectId` | `string` matching `/^[a-fA-F0-9]{24}$/`. |

The adapter's `prepareId()` converts incoming `string` ids into `ObjectId` before the driver call when the field is typed `mongo.objectId`.

For vector fields, use the core `db.vector` primitive (registered by `dbPlugin()`) together with `@db.search.vector`. There is no `mongo.vector`.

## Divergence from SQL annotations

- `@db.column` is a no-op semantically — MongoDB stores keys verbatim. Still costs the perf price of key remapping.
- `@db.rel.onDelete` / `@db.rel.onUpdate` have no native enforcement; the generic layer emulates cascades (see [relations.md](relations.md)).
- `@db.index.fulltext` maps to a legacy `text` index; for Atlas Search prefer `@db.mongo.search.static` + `@db.mongo.search.text`.
- Native FK constraints are not supported (`supportsNativeForeignKeys(): false`) → FK validation + cascades run in the application integrity strategy.
- MongoDB is the one adapter where `supportsNestedObjects(): true` (override at `packages/db-mongo/src/lib/mongo-adapter.ts`) — nested objects are stored as-is, and patches become aggregation pipelines.

## Example

```atscript
use '@atscript/db-mongo'

@db.table 'products'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 1, 'main_search'
export interface Product {
    @meta.id
    _id: mongo.objectId

    @db.mongo.search.text 'lucene.english', 'main_search'
    name: string

    @db.search.vector 1536, 'cosine', 'vec_idx'
    embedding: db.vector

    @db.search.filter 'vec_idx'
    category: string
}
```
