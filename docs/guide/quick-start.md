---
outline: deep
---

# Quick Start

<!--@include: ./_experimental-warning.md-->

This guide builds on the [TypeScript Quick Start](https://atscript.dev/packages/typescript/quick-start) — you will use the same `.as` model-driven workflow to create a database-backed application with typed CRUD operations.

::: tip What You Will Build
A **Todo app** backed by a single database table. At the end, a brief two-table example shows how relations work.
:::

::: info Recommended Reading
If you are new to Atscript, start with the [TypeScript Quick Start](https://atscript.dev/packages/typescript/quick-start) first. This guide assumes you are familiar with `.as` syntax and the compilation workflow.
:::

## 1. Install Dependencies

::: code-group

```bash [SQLite]
pnpm add @atscript/core @atscript/typescript @atscript/db @atscript/db-sqlite better-sqlite3
```

```bash [PostgreSQL]
pnpm add @atscript/core @atscript/typescript @atscript/db @atscript/db-postgres pg
```

```bash [MongoDB]
pnpm add @atscript/core @atscript/typescript @atscript/db @atscript/db-mongo mongodb
```

```bash [MySQL]
pnpm add @atscript/core @atscript/typescript @atscript/db @atscript/db-mysql mysql2
```

:::

## 2. Configure Atscript

Create `atscript.config.mts` in your project root:

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

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), dbPlugin()],
  format: "dts",
  db: {
    adapter: "@atscript/db-postgres",
    connection: "postgresql://user:password@localhost:5432/myapp",
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
    connection: "mongodb://localhost:27017/myapp",
  },
});
```

```typescript [MySQL]
import { defineConfig } from "@atscript/core";
import ts from "@atscript/typescript";
import { dbPlugin } from "@atscript/db/plugin";

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), dbPlugin()],
  format: "dts",
  db: {
    adapter: "@atscript/db-mysql",
    connection: "mysql://user:password@localhost:3306/myapp",
  },
});
```

:::

The `db` section tells the CLI which adapter to use for schema sync and where to find your database.

## 3. Define Your Schema

Create `src/schema/todo.as`:

```atscript
@db.table 'todos'
export interface Todo {
    @meta.id
    @db.default.increment
    id: number

    title: string

    description?: string

    @db.default 'false'
    completed?: boolean

    @db.default.now
    createdAt?: number.timestamp
}
```

This defines a `todos` table with an auto-incrementing primary key, a required `title`, an optional `description`, a `completed` flag that defaults to `false` when omitted, and a `createdAt` timestamp set automatically on insert.

## 4. Compile

```bash
npx asc
```

This generates type declarations (`.as.d.ts`) from your `.as` files so TypeScript can resolve types in `.ts` imports. Runtime code (`.as.js`) is not needed here — the bundler generates it in-memory via [unplugin-atscript](https://atscript.dev/packages/typescript/build-setup).

## 5. Sync Your Schema

```bash
npx asc db sync
```

Schema sync inspects your `@db.*` annotations, compares them against the live database, and applies any changes — creating tables, adding columns, and syncing indexes. See [Schema Sync](/sync/) for details.

## 6. Use in Your Application

::: code-group

```typescript [SQLite]
import { DbSpace } from "@atscript/db";
import { SqliteAdapter, BetterSqlite3Driver } from "@atscript/db-sqlite";
import { Todo } from "./schema/todo.as";

// Create a database space with a SQLite adapter
const driver = new BetterSqlite3Driver("./myapp.db");
const db = new DbSpace(() => new SqliteAdapter(driver));
```

```typescript [PostgreSQL]
import { DbSpace } from "@atscript/db";
import { PostgresAdapter, PgDriver } from "@atscript/db-postgres";
import { Todo } from "./schema/todo.as";

// Create a database space with a PostgreSQL adapter
const driver = new PgDriver({
  connectionString: "postgresql://user:password@localhost:5432/myapp",
});
const db = new DbSpace(() => new PostgresAdapter(driver));
```

```typescript [MongoDB]
import { DbSpace } from "@atscript/db";
import { MongoAdapter } from "@atscript/db-mongo";
import { MongoClient } from "mongodb";
import { Todo } from "./schema/todo.as";

// Create a database space with a MongoDB adapter
const client = new MongoClient("mongodb://localhost:27017");
await client.connect();
const db = new DbSpace(() => new MongoAdapter(client.db("myapp"), client));
```

```typescript [MySQL]
import { DbSpace } from "@atscript/db";
import { MysqlAdapter, Mysql2Driver } from "@atscript/db-mysql";
import { Todo } from "./schema/todo.as";

// Create a database space with a MySQL adapter
const driver = new Mysql2Driver("mysql://user:password@localhost:3306/myapp");
const db = new DbSpace(() => new MysqlAdapter(driver));
```

:::

Now use the table API — this is the same regardless of adapter:

```typescript
// Get a typed table
const todos = db.getTable(Todo);

// Insert
await todos.insertOne({ title: "Learn Atscript" });

// Query with filter and sort
const pending = await todos.findMany({
  filter: { completed: false },
  controls: { $sort: { createdAt: -1 } },
});

// Update
await todos.updateOne({ id: 1, completed: true });

// Delete
await todos.deleteOne(1);
```

Every operation is fully typed — `insertOne` requires `title` (the only non-optional, non-defaulted field), and `findMany` returns `Todo[]` with the correct shape.

## 7. Bonus: Adding Relations

Suppose each todo belongs to a category. Add a second `.as` file:

```atscript
@db.table 'categories'
export interface Category {
    @meta.id
    @db.default.increment
    id: number

    name: string
}
```

Then update `todo.as` to reference it:

```atscript
import { Category } from './category.as'

@db.table 'todos'
export interface Todo {
    @meta.id
    @db.default.increment
    id: number

    title: string
    description?: string

    @db.default 'false'
    completed?: boolean

    @db.default.now
    createdAt?: number.timestamp

    @db.rel.FK
    categoryId?: Category.id

    @db.rel.to
    category?: Category
}
```

Now you can load todos with their category in a single query:

```typescript
const todosWithCategory = await todos.findMany({
  controls: { $with: [{ name: "category" }] },
});
// todosWithCategory[0].category?.name → 'Work'
```

See [Relations](/relations/) for the full guide on TO, FROM, and VIA relation types.

## Next Steps

- [Tables & Fields](/api/tables) — field types, primary keys, column mappings
- [Storage & Nested Objects](/api/storage) — how nested objects and arrays are stored
- [Defaults & Generated Values](/api/defaults) — auto-generated values and static defaults
- [Relations](/relations/) — foreign keys, reverse relations, and many-to-many
- [Queries & Filters](/api/queries) — advanced filtering, sorting, and pagination
- [HTTP API](/http/) — expose your tables as REST endpoints
