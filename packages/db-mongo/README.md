<p align="center">
  <img src="https://atscript.dev/logo.svg" alt="Atscript" width="120" />
</p>

<h1 align="center">@atscript/db-mongo</h1>

<p align="center">
  <strong>Define your models once</strong> — get TypeScript types, runtime validation, and DB metadata from a single <code>.as</code> model.
</p>

<p align="center">
  <a href="https://db.atscript.dev">Documentation</a> · <a href="https://db.atscript.dev/adapters/mongodb">MongoDB Adapter</a>
</p>

---

MongoDB adapter for `@atscript/db`. Translates Atscript's portable query model into native MongoDB operations with support for Atlas Search, vector search, aggregation pipelines, capped collections, and the Convenient Transaction API.

Includes `MongoPlugin` for `@db.mongo.*` annotations and custom primitives (`mongo.objectId`, `mongo.vector`).

## Installation

```bash
pnpm add @atscript/db-mongo mongodb
```

## Quick Start

```typescript
import { DbSpace } from "@atscript/db";
import { MongoAdapter } from "@atscript/db-mongo";
import { MongoClient } from "mongodb";

const client = new MongoClient("mongodb://localhost:27017/myapp");
const db = new DbSpace(() => new MongoAdapter(client.db(), client));
const todos = db.getTable(TodoType);

await todos.insertOne({ title: "Hello", done: false });
```

## Features

- Full CRUD with native MongoDB operations
- Atlas Search: dynamic and static text indexes with analyzers and fuzzy matching
- Vector search via `@db.search.vector` with configurable dimensions and similarity
- Native relation loading via `$lookup` aggregation stages
- Aggregation pipeline support
- Array patch operations via `CollectionPatcher`
- Capped collections via `@db.mongo.capped`
- Auto-increment via atomic counter collection
- Convenient Transaction API with automatic retry

## Documentation

- [MongoDB Adapter Guide](https://db.atscript.dev/adapters/mongodb)
- [Full Documentation](https://db.atscript.dev)

## License

MIT
