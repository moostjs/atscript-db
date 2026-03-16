# @atscript/db-mongo

MongoDB metadata/primitives extension for Atscript. Provides annotations for collections, indexes, search, and patch strategies, plus `MongoAdapter` runtime class with built-in validation, filtering, querying, and writing utilities.

## Key Source Files

```
src/
  index.ts                    - Package entry: re-exports MongoPlugin, MongoAdapter
  plugin/
    index.ts                  - MongoPlugin factory (TAtscriptPlugin with name, primitives, annotations)
    annotations.ts            - All db.mongo.* annotation definitions (collection, index, search, patch, array)
    primitives.ts             - Custom primitives: mongo.objectId (string /^[a-fA-F0-9]{24}$/), mongo.vector (number[])
  lib/
    index.ts                  - Re-exports MongoAdapter, createAdapter
    mongo-adapter.ts          - MongoAdapter class: MongoDB adapter for DbSpace (CRUD, indexes, transactions)
    collection-patcher.ts     - CollectionPatcher: converts patch payloads into MongoDB aggregation pipelines
    validate-plugins.ts       - Validator plugins for ObjectId and unique array items
    logger.ts                 - TGenericLogger interface and NoopLogger
    __test__/                 - Tests and .as fixture files
```

## Usage

```typescript
import { MongoAdapter } from "@atscript/db-mongo";
import { DbSpace } from "@atscript/db";
import { MongoClient } from "mongodb";

const client = new MongoClient("mongodb://localhost:27017/myapp");
const db = new DbSpace(() => new MongoAdapter(client.db(), client));
const todos = db.getTable(TodoType);
```

The second argument (`client`) is optional — only needed for transaction support.

## Annotations

Mongo-specific annotations live under the `db.mongo.*` namespace. Generic database annotations (`@db.table`, `@db.index.*`) come from core.

### Collection-level

| Annotation                                               | Description                                          |
| -------------------------------------------------------- | ---------------------------------------------------- |
| `@db.table "name"` (core)                                | Names the collection/table                           |
| `@db.mongo.collection`                                   | Optional; auto-adds `_id: mongo.objectId` if missing |
| `@db.mongo.autoIndexes true/false`                       | Toggle automatic index creation (default: true)      |
| `@db.mongo.search.dynamic "analyzer", fuzzy`             | Dynamic Atlas Search index                           |
| `@db.mongo.search.static "analyzer", fuzzy, "indexName"` | Named static Atlas Search index                      |

### Field-level indexes

| Annotation                                                      | Description                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `@db.index.plain "indexName"` (core)                            | Standard index (compound when name shared)                       |
| `@db.index.unique "indexName"` (core)                           | Unique index                                                     |
| `@db.mongo.index.text weight`                                   | Text index with optional weight (mongo-specific, has weight arg) |
| `@db.index.fulltext "indexName"` (core)                         | Generic fulltext index (weight always 1)                         |
| `@db.mongo.search.text "analyzer", "indexName"`                 | Atlas Search text field                                          |
| `@db.mongo.search.vector dimensions, "similarity", "indexName"` | Vector search index                                              |
| `@db.mongo.search.filter "indexName"`                           | Pre-filter for vector search                                     |

### Patch and array behavior

| Annotation                                    | Description                        |
| --------------------------------------------- | ---------------------------------- |
| `@db.mongo.patch.strategy "replace"\|"merge"` | Controls update behavior           |
| `@db.mongo.array.uniqueItems`                 | Enforce set-semantics on `$insert` |

## Primitives

- **`mongo.objectId`** -- String type constrained to `/^[a-fA-F0-9]{24}$/`.
- **`mongo.vector`** -- Alias for `number[]`.

## CollectionPatcher

Converts patch payloads into MongoDB `$set` aggregation stages. Array operations: `$replace`, `$insert`, `$upsert`, `$update`, `$remove`.

## Key commands

```bash
pnpm --filter @atscript/db-mongo test     # Run this package's tests
pnpm build                             # Build all from repo root
```

### Regenerating `atscript.d.ts`

To regenerate fixture `atscript.d.ts` type declarations after annotation changes:

```bash
cd packages/db-mongo && node ../typescript/dist/cli.cjs -f dts
```

Note: The test fixtures' `atscript.d.ts` is also regenerated automatically by `prepareFixtures()` in `beforeAll`.

## Important patterns

- **Index naming**: All managed indexes use the `atscript__` prefix. `syncIndexes()` only touches these.
- **Aggregation pipelines over classic updates**: `CollectionPatcher` uses `$reduce`, `$filter`, `$map`, `$concatArrays`, `$setUnion`, `$setDifference`.
- **Fixtures compiled at test time**: `prepareFixtures()` calls `build()` + `generate()` before tests.
- **Peer dependencies**: `@atscript/core`, `@atscript/typescript`, `mongodb ^6.17.0`.
