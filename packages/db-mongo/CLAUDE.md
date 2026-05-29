# @atscript/db-mongo

MongoDB metadata/primitives extension for Atscript. Provides annotations for collections, indexes, search, and patch strategies, plus `MongoAdapter` runtime class with built-in validation, filtering, querying, and writing utilities.

## Key Source Files

```
src/
  index.ts                    - Package entry: re-exports MongoPlugin, MongoAdapter
  plugin/
    index.ts                  - MongoPlugin factory (TAtscriptPlugin with name, primitives, annotations)
    annotations.ts            - All db.mongo.* annotation definitions (collection, capped, search)
    primitives.ts             - Custom primitive: mongo.objectId (string /^[a-fA-F0-9]{24}$/)
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

### Collection-level (`db.mongo.*`)

| Annotation                                               | Description                                          |
| -------------------------------------------------------- | ---------------------------------------------------- |
| `@db.table "name"` (core)                                | Names the collection/table                           |
| `@db.mongo.collection`                                   | Optional; auto-adds `_id: mongo.objectId` if missing |
| `@db.mongo.capped size, max?`                            | Capped collection (size in bytes, optional max docs) |
| `@db.mongo.search.dynamic "analyzer", fuzzy`             | Dynamic Atlas Search index                           |
| `@db.mongo.search.static "analyzer", fuzzy, "indexName"` | Named static Atlas Search index                      |

### Field-level (`db.mongo.*`)

| Annotation                                      | Description             |
| ----------------------------------------------- | ----------------------- |
| `@db.mongo.search.text "analyzer", "indexName"` | Atlas Search text field |

Generic indexes use core annotations: `@db.index.plain`, `@db.index.unique`, `@db.index.fulltext`. Vector search uses core `@db.search.vector` / `@db.search.filter`.

### Removed (migrated to core)

These `@db.mongo.*` annotations no longer exist — see the header comment in `plugin/annotations.ts`. Do not reintroduce them:

| Removed                       | Replacement                            |
| ----------------------------- | -------------------------------------- |
| `@mongo.index.plain`          | `@db.index.plain`                      |
| `@mongo.index.unique`         | `@db.index.unique`                     |
| `@db.mongo.index.text`        | `@db.index.fulltext` (weight arg)      |
| `@db.mongo.patch.strategy`    | `@db.patch.strategy`                   |
| `@db.mongo.array.uniqueItems` | `@expect.array.uniqueItems`            |
| `@db.mongo.search.vector`     | `@db.search.vector`                    |
| `@db.mongo.search.filter`     | `@db.search.filter`                    |
| `@db.mongo.autoIndexes`       | removed — use explicit `syncIndexes()` |

## Primitives

- **`mongo.objectId`** -- String type constrained to `/^[a-fA-F0-9]{24}$/`.

Vector fields use the core `db.vector` primitive (`number[]`, from `dbPlugin()`) — there is no Mongo-specific vector primitive.

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
