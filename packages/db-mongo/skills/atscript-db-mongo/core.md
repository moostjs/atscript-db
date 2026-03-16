# Core Setup — @atscript/db-mongo

> Plugin installation, configuration, and architecture overview.

## Installation

```bash
npm install @atscript/db-mongo
# peer dependencies:
npm install @atscript/core @atscript/typescript mongodb
```

## Plugin Configuration

Add `MongoPlugin()` to your `atscript.config.ts`:

```typescript
import { defineConfig } from "@atscript/core";
import { ts } from "@atscript/typescript";
import MongoPlugin from "@atscript/db-mongo/plugin";

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), MongoPlugin()],
});
```

The plugin registers:

- **Primitives**: `mongo.objectId` (24-char hex string), `mongo.vector` (number array)
- **Annotations**: All `@db.mongo.*` annotations (collection, indexes, search, patch, array)

## Architecture

```
@atscript/db-mongo
├── plugin/
│   ├── index.ts          — MongoPlugin factory
│   ├── annotations.ts    — All db.mongo.* annotation specs
│   └── primitives.ts     — mongo.objectId, mongo.vector
└── lib/
    ├── as-mongo.ts        — AsMongo: MongoDB client wrapper
    ├── as-collection.ts   — AsCollection: collection abstraction (validation, indexes, CRUD)
    ├── collection-patcher.ts — Converts patch payloads to MongoDB aggregation pipelines
    └── validate-plugins.ts   — Validator plugins for ObjectId and unique arrays
```

## Primitives

### `mongo.objectId`

A string type constrained to `/^[a-fA-F0-9]{24}$/`. Used for MongoDB `_id` fields.

```atscript
export interface User {
    _id: mongo.objectId
    name: string
}
```

### `mongo.vector`

An alias for `number[]`. Used for vector search fields.

```atscript
export interface Document {
    embedding: mongo.vector
}
```

## Regenerating atscript.d.ts

After annotation changes, regenerate the type declarations:

```bash
cd packages/db-mongo && node ../typescript/dist/cli.cjs -f dts
```

## Best Practices

- Always use `@db.table` to name your collections — it's required by `AsCollection`
- `@db.mongo.collection` is optional — it only auto-injects `_id: mongo.objectId` if missing
- Use `mongo.objectId` type for `_id` fields when you want ObjectId-based IDs
- Use `string` type for `_id` when you want string-based IDs
