# getting-started

Install, author a `.as` model, configure, sync, and run the first CRUD call.

## Install

```bash
pnpm add @atscript/core @atscript/typescript @atscript/db
pnpm add @atscript/db-sqlite better-sqlite3        # pick exactly one adapter
```

Adapters and their peer deps:

| Adapter                 | Peer                                      |
| ----------------------- | ----------------------------------------- |
| `@atscript/db-sqlite`   | `better-sqlite3`                          |
| `@atscript/db-postgres` | `pg`, optional `pgvector` extension in DB |
| `@atscript/db-mysql`    | `mysql2`                                  |
| `@atscript/db-mongo`    | `mongodb ^6`                              |

## Configure Atscript

`atscript.config.mts` at project root:

```ts
import { defineConfig } from "@atscript/core";
import ts from "@atscript/typescript";
import { dbPlugin } from "@atscript/db/plugin";

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), dbPlugin()],
  format: "dts",
  // Used by `npx asc db sync` CLI — programmatic sync does not read this.
  db: {
    adapter: "@atscript/db-sqlite",
    connection: "./app.db",
  },
});
```

Adapter-specific plugins extend the annotation surface:

```ts
import { PostgresPlugin } from "@atscript/db-postgres";
import { MysqlPlugin } from "@atscript/db-mysql";
import { MongoPlugin } from "@atscript/db-mongo/plugin"; // note: /plugin subpath

plugins: [ts(), dbPlugin(), PostgresPlugin()]; // adds @db.pg.*
```

## Author a model

```atscript
// src/todo.as
@db.table 'todos'
@db.deep.insert 0                           // explicit: reject nested insert payloads
export interface Todo {
    @meta.id @db.default.increment
    id: number

    title: string
    description?: string

    @db.default 'false'
    completed?: boolean

    @db.default.now
    createdAt?: number.timestamp
}
```

## Compile

```bash
npx asc            # emits src/*.as.d.ts + project-wide atscript.d.ts (type only, no runtime JS)
```

For runtime `.as.js` (bundler integration), use `unplugin-atscript` — see skill `moostjs/atscript`.

## Wire a DbSpace

```ts
import { DbSpace } from "@atscript/db";
import { SqliteAdapter, BetterSqlite3Driver } from "@atscript/db-sqlite";
import { Todo } from "./todo.as";

const driver = new BetterSqlite3Driver("./app.db"); // or ':memory:' for tests
const db = new DbSpace(() => new SqliteAdapter(driver)); // factory runs once per table
```

One-liner helpers exist on each SQL adapter package:

```ts
import { createAdapter } from "@atscript/db-sqlite";
const db = createAdapter(":memory:");
```

## Sync the schema

```ts
import { syncSchema } from "@atscript/db/sync";
await syncSchema(db, [Todo]); // idempotent, lock-coordinated
```

Or from the CLI: `npx asc db sync`.

## First CRUD call

```ts
const todos = db.getTable(Todo); // typed AtscriptDbTable<Todo>
const res = await todos.insertOne({ title: "ship it" }); // { insertedId: 1 }
const pending = await todos.findMany({ filter: { completed: false } });
await todos.updateOne({ id: 1, completed: true }); // PK must be in payload
await todos.deleteOne(1); // scalar OR composite id object
```
