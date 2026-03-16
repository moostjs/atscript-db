---
outline: deep
---

# SQLite

<!--@include: ../_experimental-warning.md-->

The SQLite adapter (`@atscript/db-sqlite`) connects your `.as` models to SQLite databases. Zero-config, single-file storage, and no server process make SQLite the fastest way to get started with Atscript's DB layer. Best suited for development, testing, and lightweight production workloads.

Uses `better-sqlite3` by default, but any driver implementing the `TSqliteDriver` interface works — including Node.js built-in `node:sqlite`.

## Installation

```bash
pnpm add @atscript/db-sqlite better-sqlite3
```

`better-sqlite3` is an optional peer dependency. You can substitute any SQLite driver that implements the `TSqliteDriver` interface.

## Setup

Create a driver, wrap it in an adapter, and pass the adapter factory to `DbSpace`:

```typescript
import { DbSpace } from "@atscript/db";
import { SqliteAdapter, BetterSqlite3Driver } from "@atscript/db-sqlite";
import { User } from "./user.as.js";

// 1. Create driver
const driver = new BetterSqlite3Driver("./myapp.db");

// 2. Create DbSpace with adapter factory
const db = new DbSpace(() => new SqliteAdapter(driver));

// 3. Get typed tables
const users = db.getTable(User);
```

Or use the convenience shorthand:

```typescript
import { createAdapter } from "@atscript/db-sqlite";
import { User } from "./user.as.js";

const db = createAdapter("./myapp.db");
const users = db.getTable(User);
```

Once you have a table, run `npx asc db sync` to create or update the database schema, then use `users.insertOne(...)`, `users.findMany(...)`, etc. See [CRUD Operations](/api/crud) for the full API.

## Adapter-Specific Annotations

SQLite has **no adapter-specific annotations**. All generic `@db.*` annotations work as documented in the [Annotations Reference](./annotations). There is no `@db.sqlite.*` namespace.

## Type Mapping

Atscript types map to SQLite column types as follows:

| Atscript Type     | SQLite Type       | Notes                                        |
| ----------------- | ----------------- | -------------------------------------------- |
| `string`          | `TEXT`            |                                              |
| `number`          | `REAL`            | `INTEGER` for primary keys (aliases `rowid`) |
| `decimal`         | `REAL`            | Runtime value is string; coerced on read     |
| `boolean`         | `INTEGER`         | Stored as `0` / `1`                          |
| arrays            | `TEXT`            | JSON-serialized                              |
| nested objects    | flattened columns | `parent__child` naming convention            |
| `@db.json` fields | `TEXT`            | JSON-serialized                              |

## Features

### Nested Objects

Nested object fields are automatically flattened into `__`-separated columns. You query with dot-notation and the adapter translates:

```atscript
@db.table 'contacts'
export interface Contact {
    @meta.id
    id: number

    name: string

    // Becomes columns: address__city, address__zip
    address: {
        city: string
        zip: string
    }
}
```

```typescript
// Insert — pass the nested structure naturally
await contacts.insertOne({
  id: 1,
  name: "Alice",
  address: { city: "Portland", zip: "97201" },
});

// Query — use dot-notation for nested fields
const results = await contacts.findMany({
  filter: { "address.city": "Portland" },
  controls: { $sort: { "address.zip": 1 } },
});

// Read — nested objects are reconstructed automatically
// results[0].address -> { city: 'Portland', zip: '97201' }
```

To store an entire nested object as a single JSON column instead of flattening, annotate it with `@db.json`. Arrays are always stored as JSON.

### Foreign Key Enforcement

SQLite foreign keys are enforced natively. The adapter enables `PRAGMA foreign_keys = ON` at connection time, so referential integrity is always active. Cascade and set-null behaviors are controlled via `@db.rel.onDelete` and `@db.rel.onUpdate` — see [Referential Actions](/relations/referential-actions).

### Fulltext Search (FTS5)

SQLite supports fulltext search through FTS5 virtual tables. When you annotate fields with `@db.index.fulltext`, the adapter automatically creates FTS5 virtual tables with sync triggers that keep the index up to date on inserts, updates, and deletes.

```atscript
@db.table 'articles'
export interface Article {
    @meta.id
    id: number

    @db.index.fulltext
    title: string

    @db.index.fulltext
    body: string
}
```

The adapter creates a companion `articles__fts__<indexName>` virtual table and triggers for automatic synchronization. Use the `search()` method to query:

```typescript
const results = await articles.search("database optimization", {});
```

::: info FTS5 Query Syntax
FTS5 uses its own match syntax (e.g., `"exact phrase"`, `term1 AND term2`, `prefix*`). This differs from the simple text search APIs of PostgreSQL or MongoDB. See the [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html) for query syntax details.
:::

### Filters

All standard filter operators are supported (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$and`, `$or`, `$not`). Regex patterns are converted to SQL `LIKE` expressions:

| Regex Pattern | SQL LIKE | Matches           |
| ------------- | -------- | ----------------- |
| `^abc`        | `abc%`   | Starts with "abc" |
| `end$`        | `%end`   | Ends with "end"   |
| `^exact$`     | `exact`  | Exact match       |
| `mid`         | `%mid%`  | Contains "mid"    |

```typescript
// Pattern matching
await users.findMany({
  filter: { name: { $regex: "^Ali" } },
  controls: {},
});
// -> WHERE name LIKE 'Ali%'
```

### Table Recreation

SQLite does not support `ALTER COLUMN` for type changes. When schema sync detects a column type change, the adapter performs a safe table recreation:

1. Creates a new table with the updated schema
2. Copies data from the old table (with `COALESCE` for new NOT NULL columns)
3. Renames old table out of the way, renames new table into place
4. Drops the old table

Foreign key checks are temporarily disabled during recreation to avoid constraint errors on intermediate states. To opt a table into this behavior, annotate it with `@db.sync.method 'recreate'`. See [Schema Sync](/sync/) for details.

### In-Memory Databases

Pass `':memory:'` as the path to create an in-memory database — useful for tests and ephemeral data:

```typescript
const driver = new BetterSqlite3Driver(":memory:");
const db = new DbSpace(() => new SqliteAdapter(driver));
```

In-memory databases are lost when the process exits or the driver is closed.

### Custom Drivers

The `SqliteAdapter` accepts any object implementing `TSqliteDriver`. This lets you use `node:sqlite`, `sql.js`, or any other SQLite binding:

```typescript
interface TSqliteDriver {
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all<T>(sql: string, params?: unknown[]): T[];
  get<T>(sql: string, params?: unknown[]): T | null;
  exec(sql: string): void;
  close(): void;
}
```

Example using Node.js built-in `node:sqlite`:

```typescript
import { SqliteAdapter } from "@atscript/db-sqlite";
import { DatabaseSync } from "node:sqlite";

const nodeDb = new DatabaseSync(":memory:");
const driver = {
  run(sql, params) {
    const stmt = nodeDb.prepare(sql);
    return stmt.run(...(params ?? []));
  },
  all(sql, params) {
    const stmt = nodeDb.prepare(sql);
    return stmt.all(...(params ?? []));
  },
  get(sql, params) {
    const stmt = nodeDb.prepare(sql);
    return stmt.get(...(params ?? [])) ?? null;
  },
  exec(sql) {
    nodeDb.exec(sql);
  },
  close() {
    nodeDb.close();
  },
};

const adapter = new SqliteAdapter(driver);
```

### BetterSqlite3Driver

The built-in `BetterSqlite3Driver` accepts either a file path (string) or a pre-created `better-sqlite3` `Database` instance:

```typescript
// From file path
const driver = new BetterSqlite3Driver("./data.db");

// From existing instance
import Database from "better-sqlite3";
const instance = new Database("./data.db", { verbose: console.log });
const driver = new BetterSqlite3Driver(instance);
```

The driver uses `createRequire` internally, so `better-sqlite3` remains an optional dependency — it is only loaded when `BetterSqlite3Driver` is instantiated.

## Limitations

- **No ALTER COLUMN type changes** — column type modifications require full table recreation. Use `@db.sync.method 'recreate'` to opt in. See [Schema Sync](/sync/) for details.
- **FTS5-based fulltext search** — fulltext indexes are managed automatically, but FTS5 uses its own match syntax rather than standard SQL pattern matching.
- **No database schemas** — the `@db.schema` annotation is ignored (SQLite has no schema namespaces).
- **No vector search** — no equivalent of pgvector or Atlas vectorSearch.
- **No native boolean type** — booleans are stored as `INTEGER` (`0`/`1`).
- **No native array/JSON operations** — array patch operators (`$push`, `$pull`) use generic read-modify-write instead of native operations.
- **Synchronous driver** — both `better-sqlite3` and `node:sqlite` are synchronous; the adapter wraps calls in promises for the async `BaseDbAdapter` contract.
- **No native UUID generation** — UUIDs must be generated application-side.

## Utilities

The package exports `buildWhere` for constructing SQL WHERE clauses from filter objects — useful when writing custom queries outside the standard CRUD flow:

```typescript
import { buildWhere } from "@atscript/db-sqlite";

const { sql, params } = buildWhere({ status: "active", age: { $gte: 18 } });
// sql -> 'WHERE "status" = ? AND "age" >= ?'
// params -> ['active', 18]
```

## Next Steps

- [PostgreSQL](./postgresql) — full-featured adapter with pgvector and transactional DDL
- [MongoDB](./mongodb) — document-oriented adapter with Atlas Search
- [Adapter Overview](./) — feature comparison across all adapters
