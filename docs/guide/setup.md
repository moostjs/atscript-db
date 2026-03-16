---
outline: deep
---

# Setup

This page is the canonical setup reference for Atscript's DB layer. It covers package installation, plugin registration, adapter configuration, and how to create a `DbSpace` — the entry point for all database operations.

## Installing Packages

Every project needs the core trio plus one adapter package for your database:

```bash
# Core packages (always required)
pnpm add @atscript/core @atscript/typescript @atscript/db
```

Then add the adapter for your database:

::: code-group

```bash [SQLite]
pnpm add @atscript/db-sqlite better-sqlite3
```

```bash [PostgreSQL]
pnpm add @atscript/db-postgres pg
```

```bash [MongoDB]
pnpm add @atscript/db-mongo mongodb
```

```bash [MySQL]
pnpm add @atscript/db-mysql mysql2
```

:::

## Registering the DB Plugin

The `dbPlugin()` function registers all `@db.*` annotations (`@db.table`, `@db.index.*`, `@db.column.*`, `@db.default.*`, `@db.rel.*`, `@db.view.*`, `@db.search.*`, `@db.agg.*`, `@db.patch.*`, etc.) and the `db.vector` primitive type. Call it in your config **before** compiling `.as` files:

```typescript
import { defineConfig } from "@atscript/core";
import ts from "@atscript/typescript";
import { dbPlugin } from "@atscript/db/plugin";

export default defineConfig({
  plugins: [ts(), dbPlugin()],
  // ...
});
```

::: info Adapter-Specific Plugins
PostgreSQL and MySQL ship their own plugins for adapter-specific annotations:

- **PostgreSQL**: `PostgresPlugin()` from `@atscript/db-postgres` — registers `@db.pg.*` annotations
- **MySQL**: `MysqlPlugin()` from `@atscript/db-mysql` — registers `@db.mysql.*` annotations

Add them alongside `dbPlugin()` if you use adapter-specific features.
:::

## Configuration File

Create `atscript.config.mts` (or `atscript.config.ts`) in your project root:

::: code-group

```typescript [SQLite]
import { defineConfig } from "@atscript/core";
import ts from "@atscript/typescript";
import { dbPlugin } from "@atscript/db/plugin";

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), dbPlugin()],
  format: "dts",
  db: {
    adapter: "@atscript/db-sqlite",
    connection: "./myapp.db",
  },
});
```

```typescript [PostgreSQL]
import { defineConfig } from "@atscript/core";
import ts from "@atscript/typescript";
import { dbPlugin } from "@atscript/db/plugin";
import { PostgresPlugin } from "@atscript/db-postgres";

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), dbPlugin(), PostgresPlugin()],
  format: "dts",
  db: {
    adapter: "@atscript/db-postgres",
    connection: "postgresql://user@localhost:5432/mydb",
  },
});
```

```typescript [MongoDB]
import { defineConfig } from "@atscript/core";
import ts from "@atscript/typescript";
import { dbPlugin } from "@atscript/db/plugin";

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), dbPlugin()],
  format: "dts",
  db: {
    adapter: "@atscript/db-mongo",
    connection: "mongodb://localhost:27017/mydb",
  },
});
```

```typescript [MySQL]
import { defineConfig } from "@atscript/core";
import ts from "@atscript/typescript";
import { dbPlugin } from "@atscript/db/plugin";
import { MysqlPlugin } from "@atscript/db-mysql";

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), dbPlugin(), MysqlPlugin()],
  format: "dts",
  db: {
    adapter: "@atscript/db-mysql",
    connection: "mysql://root@localhost:3306/mydb",
  },
});
```

:::

The `db` section tells the CLI which adapter to use for [schema sync](/sync/) and how to connect. It accepts either a declarative object:

```typescript
db: {
  adapter: '@atscript/db-sqlite',   // adapter package name
  connection: './myapp.db',          // connection string or factory
  options: { /* adapter-specific */ },
  include: ['src/schema/**/*.as'],   // optional: limit which .as files are synced
  exclude: [],
}
```

Or a factory function for advanced setups:

```typescript
db: () => createCustomDbSpace();
```

## Creating a DbSpace

`DbSpace` is the runtime entry point. It manages adapter lifecycle, table/view instances, and cross-table discovery for relations.

```typescript
import { DbSpace } from "@atscript/db";
```

The constructor takes an **adapter factory** — a function that returns a new `BaseDbAdapter` instance. Each table and view gets its own adapter instance (1:1), because adapters store per-table state (metadata, column maps, type mappings).

::: code-group

```typescript [SQLite]
import { SqliteAdapter, BetterSqlite3Driver } from "@atscript/db-sqlite";

const driver = new BetterSqlite3Driver("./myapp.db");
const db = new DbSpace(() => new SqliteAdapter(driver));
```

```typescript [PostgreSQL]
import { PostgresAdapter, PgDriver } from "@atscript/db-postgres";

const driver = new PgDriver("postgresql://user@localhost:5432/mydb");
const db = new DbSpace(() => new PostgresAdapter(driver));
```

```typescript [MongoDB]
import { MongoAdapter } from "@atscript/db-mongo";
import { MongoClient } from "mongodb";

const client = new MongoClient("mongodb://localhost:27017/mydb");
const db = new DbSpace(() => new MongoAdapter(client.db(), client));
```

```typescript [MySQL]
import { MysqlAdapter, Mysql2Driver } from "@atscript/db-mysql";

const driver = new Mysql2Driver("mysql://root@localhost:3306/mydb");
const db = new DbSpace(() => new MysqlAdapter(driver));
```

:::

::: tip createAdapter Shorthand
Each adapter package exports a `createAdapter()` function that creates the driver and `DbSpace` in one call:

```typescript
import { createAdapter } from "@atscript/db-sqlite";
const db = createAdapter("./myapp.db");

import { createAdapter } from "@atscript/db-postgres";
const db = createAdapter("postgresql://user@localhost:5432/mydb");

import { createAdapter } from "@atscript/db-mongo";
const db = createAdapter("mongodb://localhost:27017/mydb");

import { createAdapter } from "@atscript/db-mysql";
const db = createAdapter("mysql://root@localhost:3306/mydb");
```

:::

## Registering Types

Get typed table and view instances by passing compiled `.as` types to the space:

```typescript
import { User } from "./schema/user.as";
import { ActiveUsers } from "./schema/active-users.as";

const users = db.getTable(User); // AtscriptDbTable<typeof User>
const activeUsers = db.getView(ActiveUsers); // AtscriptDbView<typeof ActiveUsers>
```

If you don't know whether a type is a table or view, use `get()` — it auto-detects by checking for `@db.view` or `@db.view.for` metadata:

```typescript
const readable = db.get(SomeType); // table or view, auto-detected
```

All three methods are **lazy** — the table/view and its adapter are created on first access and cached (via `WeakMap`) for subsequent calls.

## Next Steps

- [Tables & Fields](/api/tables) — Field types, nested objects, column mappings
- [Storage & Nested Objects](/api/storage) — How nested objects are stored
- [CRUD Operations](/api/crud) — Insert, read, update, delete
- [Schema Sync](/sync/) — Automatic schema migrations
- [Adapters](/adapters/) — Adapter-specific configuration and features
