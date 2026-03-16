<p align="center">
  <img src="https://atscript.dev/logo.svg" alt="Atscript" width="120" />
</p>

<h1 align="center">@atscript/db-sqlite</h1>

<p align="center">
  <strong>Define your models once</strong> — get TypeScript types, runtime validation, and DB metadata from a single <code>.as</code> model.
</p>

<p align="center">
  <a href="https://db.atscript.dev">Documentation</a> · <a href="https://db.atscript.dev/adapters/sqlite">SQLite Adapter</a>
</p>

---

SQLite adapter for `@atscript/db` with a swappable driver architecture. Ships with a `BetterSqlite3Driver` for `better-sqlite3` and supports custom drivers for `node:sqlite` (Node 22.5+), `sql.js`, or any other SQLite engine.

## Installation

```bash
pnpm add @atscript/db-sqlite better-sqlite3
```

## Quick Start

```typescript
import { DbSpace } from "@atscript/db";
import { createAdapter } from "@atscript/db-sqlite";

const db = createAdapter("./myapp.db");
const users = db.getTable(UsersType);

await users.insertOne({ name: "John", email: "john@example.com" });
```

## Features

- Swappable driver via `TSqliteDriver` interface (5 methods)
- Built-in `BetterSqlite3Driver` for immediate use
- MongoDB-style filter translation to parameterized SQL (no injection risk)
- Automatic schema management from `@db.*` annotations
- FTS5 full-text search support
- Embedded object flattening and `@db.json` storage
- Schema sync via `@atscript/db/sync`

## Documentation

- [SQLite Adapter Guide](https://db.atscript.dev/adapters/sqlite)
- [Full Documentation](https://db.atscript.dev)

## License

MIT
