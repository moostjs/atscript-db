---
outline: deep
---

# HTTP Setup

`@atscript/moost-db` provides zero-boilerplate REST controllers that expose your [tables](/api/tables) and [views](/views/) as HTTP endpoints via the [Moost](https://moost.org) framework. Define your schema once in a `.as` file, wire up a table, and get a full CRUD API with no endpoint code to write.

## Installation

```bash
pnpm add @atscript/moost-db @moostjs/event-http moost
```

You also need a database adapter:

```bash
# Pick one (or more)
pnpm add @atscript/db-sqlite better-sqlite3   # SQLite
pnpm add @atscript/db-mongo mongodb           # MongoDB
```

## Minimal Working Example

### 1. Define Your Schema

Create a `.as` file with `@db.*` annotations:

```atscript
// schema/todo.as
@db.table 'todos'
export interface Todo {
    @meta.id
    @db.default.increment
    id: number

    title: string

    description?: string

    @db.default 'false'
    completed: boolean

    @db.default 'medium'
    priority: string

    createdAt?: number.timestamp.created
}
```

### 2. Create DbSpace and Table

```typescript
import { DbSpace } from "@atscript/db";
import { BetterSqlite3Driver, SqliteAdapter } from "@atscript/db-sqlite";
import { Todo } from "./schema/todo.as";

const driver = new BetterSqlite3Driver("./todos.db");
const dbSpace = new DbSpace(() => new SqliteAdapter(driver));
const todosTable = dbSpace.getTable(Todo);
```

### 3. Create the Controller

Extend `AsDbController` and apply the `@TableController` decorator:

```typescript
import { AsDbController, TableController } from "@atscript/moost-db";
import { Todo } from "./schema/todo.as";
import { todosTable } from "./db";

@TableController(todosTable)
export class TodoController extends AsDbController<typeof Todo> {}
```

That single line gives you a complete CRUD API — no endpoint methods to write.

### 4. Register in Moost App

```typescript
import { Moost } from "moost";
import { MoostHttp } from "@moostjs/event-http";
import { TodoController } from "./controllers/todo.controller";

const app = new Moost();
app.adapter(new MoostHttp()).listen(3000);
app.registerControllers(["todos", TodoController]);
await app.init();
```

### 5. Try It

```bash
# Insert a record
curl -X POST http://localhost:3000/todos/ \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy milk", "priority": "high"}'

# List all records
curl http://localhost:3000/todos/query
```

## Controller Types

### AsDbController (Full CRUD)

Provides both read and write endpoints for tables:

| Method   | Path       | Description                                      |
| -------- | ---------- | ------------------------------------------------ |
| `GET`    | `/query`   | List records with filtering, sorting, pagination |
| `GET`    | `/pages`   | Paginated results with metadata                  |
| `GET`    | `/one/:id` | Single record by primary key                     |
| `POST`   | `/`        | Insert one or many records                       |
| `PUT`    | `/`        | Replace one or many records                      |
| `PATCH`  | `/`        | Update one or many records                       |
| `DELETE` | `/:id`     | Delete by primary key                            |
| `GET`    | `/meta`    | Table metadata for UI tooling                    |

Use `@TableController` to wire it up:

```typescript
@TableController(todosTable)
export class TodoController extends AsDbController<typeof Todo> {}
```

See [CRUD Endpoints](./crud) for detailed documentation of each endpoint.

### AsDbReadableController (Read-Only)

Provides only read endpoints — no write operations. Use for [views](/views/) or tables where writes aren't needed:

| Method | Path       | Description                                      |
| ------ | ---------- | ------------------------------------------------ |
| `GET`  | `/query`   | List records with filtering, sorting, pagination |
| `GET`  | `/pages`   | Paginated results with metadata                  |
| `GET`  | `/one/:id` | Single record by primary key                     |
| `GET`  | `/meta`    | Table/view metadata                              |

Use `@ReadableController` (or the alias `@ViewController`):

```typescript
import { AsDbReadableController, ReadableController } from "@atscript/moost-db";
import { ActiveTask } from "./schema/active-tasks.as";
import { activeTasksView } from "./db";

@ReadableController(activeTasksView)
export class ActiveTasksController extends AsDbReadableController<typeof ActiveTask> {}
```

`POST`, `PUT`, `PATCH`, and `DELETE` are not registered — clients receive 404 for these methods.

::: tip ViewController
`@ViewController` is an alias for `@ReadableController` — they are interchangeable. Use whichever reads better in context.
:::

## Route Configuration

By default, the controller route prefix is derived from the `@db.table` (or `@db.view`) name.

**Override via decorator:**

```typescript
@TableController(todosTable, "api/v1/todos")
export class TodoController extends AsDbController<typeof Todo> {}
```

**Override via registration:**

```typescript
app.registerControllers(["api/v1/todos", TodoController]);
```

Both `@ReadableController` and `@ViewController` accept the same optional prefix argument.

### Multiple Controllers

Mount multiple tables and views on different route prefixes:

```typescript
app.registerControllers(
  ["todos", TodoController],
  ["projects", ProjectController],
  ["stats", StatsViewController],
);
```

## Relationship to DbSpace

The controller operates on the same `DbSpace` that your programmatic code uses. This means:

- **Shared transactions** — HTTP operations participate in the same transaction context (via `AsyncLocalStorage`)
- **Shared adapter instances** — no separate connection pools for HTTP vs programmatic access
- **Consistent behavior** — the same filters, validations, and relation loading work identically

See [Setup](/guide/setup) for details on configuring `DbSpace`.

## Adapter Agnostic

The same controller code works identically regardless of which database adapter backs the table. Swap the adapter in your table setup and the HTTP API stays unchanged:

```typescript
// Switch from SQLite to MongoDB — no controller changes needed
import { MongoAdapter } from "@atscript/db-mongo";

const dbSpace = new DbSpace(() => new MongoAdapter(db, client));
const todosTable = dbSpace.getTable(Todo);
```

## Next Steps

- [CRUD Endpoints](./crud) — Detailed documentation for each endpoint
- [URL Query Syntax](./query-syntax) — Filter, sort, and paginate via URL parameters
- [Relations & Search in URLs](./advanced) — Relation loading, text search, vector search
- [Customization](./customization) — Hooks for access control, data transformation, and extending controllers
- [HTTP Client](./client) — Browser-compatible TypeScript client for these endpoints
