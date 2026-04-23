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
| `@db.mongo.autoIndexes`    | `boolean`                                               | Toggle automatic index creation during `syncIndexes()` (default: `true`).                          |
| `@db.mongo.search.dynamic` | `analyzer?: string, fuzzy?: number`                     | Dynamic Atlas Search index (indexes all string fields).                                            |
| `@db.mongo.search.static`  | `analyzer?: string, fuzzy?: number, indexName?: string` | Named static Atlas Search index. Combine with `@db.mongo.search.text` on individual fields.        |

## Field-level

| Annotation                    | Args                                                          | Effect                                                 |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| `@db.mongo.search.text`       | `analyzer?: string, indexName?: string`                       | Include field in a named static Atlas Search index.    |
| `@db.mongo.search.vector`     | `dimensions: number, similarity?: string, indexName?: string` | Atlas Search vector index on this field.               |
| `@db.mongo.search.filter`     | `indexName: string`                                           | Pre-filter field for a specific vector index.          |
| `@db.mongo.index.text`        | `weight?: number`                                             | Legacy MongoDB `text` index with per-field weight.     |
| `@db.mongo.patch.strategy`    | `'replace' \| 'merge'`                                        | Per-field override of the global `@db.patch.strategy`. |
| `@db.mongo.array.uniqueItems` | —                                                             | Enforces set-semantics on `$insert` array ops.         |

## Primitives added by the plugin

| Primitive        | Type constraint                          |
| ---------------- | ---------------------------------------- |
| `mongo.objectId` | `string` matching `/^[a-fA-F0-9]{24}$/`. |
| `mongo.vector`   | `number[]` (alias).                      |

The adapter's `prepareId()` converts incoming `string` ids into `ObjectId` before the driver call when the field is typed `mongo.objectId`.

## Divergence from SQL annotations

- `@db.column` is a no-op semantically — MongoDB stores keys verbatim. Still costs the perf price of key remapping.
- `@db.rel.onDelete` / `@db.rel.onUpdate` have no native enforcement; the generic layer emulates cascades (see `relations.md`).
- `@db.index.fulltext` maps to a legacy `text` index; for Atlas Search prefer `@db.mongo.search.static` + `@db.mongo.search.text`.
- Native FK constraints are not supported (`supportsNativeForeignKeys(): false`) → FK validation + cascades run in the application integrity strategy.
- MongoDB is the one adapter where `supportsNestedObjects(): true` — nested objects are stored as-is, and patches become aggregation pipelines.

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
    embedding: mongo.vector

    @db.search.filter 'vec_idx'
    category: string
}
```
