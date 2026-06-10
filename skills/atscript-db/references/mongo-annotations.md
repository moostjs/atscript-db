# mongo-annotations

Requires the Mongo plugin in `atscript.config`:

```ts
import { MongoPlugin } from "@atscript/db-mongo";
plugins: [ts(), dbPlugin(), MongoPlugin()];
```

## Collection-level

| Annotation                 | Args                                                                       | Effect                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@db.mongo.collection`     | —                                                                          | Mark as Mongo collection. Auto-injects `_id: mongo.objectId` when the interface has no `@meta.id`.                                               |
| `@db.mongo.capped`         | `size: number, max?: number`                                               | Capped collection (bytes; optional doc limit).                                                                                                   |
| `@db.mongo.search.dynamic` | `analyzer?: string, fuzzy?: number`                                        | Dynamic Atlas Search index (indexes all string fields).                                                                                          |
| `@db.mongo.search.static`  | `analyzer?: string, fuzzy?: number, indexName?: string, strategy?: string` | Named static Atlas Search index. Combine with `@db.mongo.search.text` / `.autocomplete` on fields. `strategy` locks the query shape (see below). |

## Field-level

| Annotation                      | Args                                                                                                                           | Effect                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@db.mongo.search.text`         | `analyzer?: string, indexName?: string`                                                                                        | Include field in a named static Atlas Search index as a **word-matched** (`string`) field.                                                                                                                              |
| `@db.mongo.search.autocomplete` | `indexName?: string, tokenization?: string, minGrams?: number, maxGrams?: number, foldDiacritics?: boolean, analyzer?: string` | Include field as a **prefix/typeahead** (`autocomplete`) field, double-mapped as `string` so exact-word hits still rank. `tokenization`: `edgeGram` (prefix, default) / `nGram` (substring) / `rightEdgeGram` (suffix). |

### Search behavior is declared, not query-time

The index's matching behavior is **locked in the annotation** — that is how Atlas itself works (the tokenization/analyzer/fuzzy are baked into the index at build time). A `$search` request just sends a term; the index runs the behavior you declared:

- `fuzzy` (`0`/off · `1` · `2`) on `@db.mongo.search.static`/`.dynamic` is **query-time typo tolerance** applied to the emitted operator (not stored in the index definition). Override per request with the `$fuzzy` control.
- `strategy` on `@db.mongo.search.static` fixes the query shape:
  - `compound` (default) → wildcard `text` clause **plus** one `autocomplete` clause per autocomplete field (exact ranks above prefix). Degrades to plain `text` when the index has no autocomplete field — so unset behaves like before.
  - `autocomplete` → **prefix/typeahead only** (autocomplete fields, no word-match clause). A single autocomplete field emits one `autocomplete` operator; several emit a `compound.should` of them.
  - `text` → **word matching only** — a single `text` operator over all string-mapped fields (autocomplete fields match via their companion `string` mapping).

### Variants: one index per behavior, picked by `$index`

To use the **same data matched differently**, do not parameterize the query — define each behavior as its own central index and select per request with `$index`. One field can join several indexes:

```atscript
@db.table 'users'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 0, 'users_exact'    # word match, no fuzzy
@db.mongo.search.static 'lucene.english', 1, 'users_prefix'   # typeahead + fuzzy
export interface User {
    @meta.id
    _id: mongo.objectId

    @db.mongo.search.text 'lucene.english', 'users_exact'
    @db.mongo.search.autocomplete 'users_prefix'
    username: string
}
```

`GET /query?$search=art` → first-declared index (`users_exact`, word match). `GET /query?$search=art&$index=users_prefix` → the typeahead variant. Same field, two locked behaviors, no query-time modes.

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
