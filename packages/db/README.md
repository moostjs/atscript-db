<p align="center">
  <img src="https://db.atscript.dev/logo.svg" alt="Atscript" width="120" />
</p>

<h1 align="center">@atscript/db</h1>

<p align="center">
  <strong>Define your models once</strong> — get TypeScript types, runtime validation, and DB metadata from a single <code>.as</code> model.
</p>

<p align="center">
  <a href="https://db.atscript.dev">Documentation</a> · <a href="https://db.atscript.dev/guide/">Database Guide</a>
</p>

---

Generic database abstraction layer for Atscript. Provides unified CRUD, relations, views, aggregations, and schema sync — all driven by `@db.*` annotations in your `.as` models. Pluggable adapters connect any database engine (SQLite, PostgreSQL, MongoDB, MySQL).

## Installation

```bash
pnpm add @atscript/db
```

## Quick Start

```atscript
@db.table "users"
interface User {
  @meta.id
  @db.default.increment
  id: number

  @db.index.unique "email_idx"
  email: string

  name: string
}
```

```typescript
import { DbSpace } from "@atscript/db";
import { createAdapter } from "@atscript/db-sqlite";

const db = createAdapter("./myapp.db");
const users = db.getTable(User);

await users.insertOne({ name: "John", email: "john@example.com" });
const all = await users.findMany({ filter: { name: { $eq: "John" } } });
```

## Sub-entries

| Entry                 | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `@atscript/db/plugin` | `dbPlugin()` — registers all `@db.*` annotations         |
| `@atscript/db/rel`    | Relation loading and nested writes                       |
| `@atscript/db/agg`    | Aggregation query validation                             |
| `@atscript/db/sync`   | Schema sync with drift detection and distributed locking |
| `@atscript/db/shared` | Annotation helpers for adapter plugins                   |

## Features

- Annotation-driven schema: table names, indexes, column mappings, defaults, primary keys
- Pluggable adapters via `BaseDbAdapter` — same code works with any database
- Automatic write pipeline: defaults, validation, ID preparation, column mapping
- Embedded object flattening (`__`-separated columns) and `@db.json` storage
- Relations: `@db.rel.to`, `@db.rel.from`, `@db.rel.via` with nested writes
- Views: `@db.view` with joins, filters, materialized views, aggregation
- Schema sync: FNV-1a hash drift detection, distributed locking, column/table renames
- Array patch operations: `$insert`, `$upsert`, `$update`, `$remove`, `$replace`
- Type-safe queries with `FlatOf<T>` for autocomplete on filters and projections

## Documentation

- [Database Guide](https://db.atscript.dev/guide/)
- [API & Annotations](https://db.atscript.dev/api/tables)
- [Full Documentation](https://db.atscript.dev)

## License

MIT
