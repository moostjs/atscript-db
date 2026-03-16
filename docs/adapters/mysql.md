---
outline: deep
---

# MySQL

<!--@include: ../_experimental-warning.md-->

The MySQL adapter (`@atscript/db-mysql`) connects your `.as` models to MySQL and MariaDB databases via the `mysql2` driver. MySQL offers wide hosting availability, native FULLTEXT indexes for text search, `VECTOR(N)` columns in MySQL 9.0+, and in-place column modification through `ALTER TABLE MODIFY COLUMN`.

## Installation

```bash
pnpm add @atscript/db-mysql mysql2
```

`mysql2` is an optional peer dependency. The adapter dynamically imports it when the driver is first used.

## Setup

### Driver and Adapter

Create a `Mysql2Driver` with your connection details, then wrap it in a `MysqlAdapter` factory via `DbSpace`:

```typescript
import { DbSpace } from "@atscript/db";
import { MysqlAdapter, Mysql2Driver } from "@atscript/db-mysql";

const driver = new Mysql2Driver({
  host: "localhost",
  port: 3306,
  user: "root",
  password: "password",
  database: "myapp",
});
const db = new DbSpace(() => new MysqlAdapter(driver));
```

`Mysql2Driver` accepts three input forms:

```typescript
// Connection URI string
const driver = new Mysql2Driver("mysql://root:pass@localhost:3306/mydb");

// Pool options object
const driver = new Mysql2Driver({
  host: "localhost",
  user: "root",
  database: "mydb",
  waitForConnections: true,
  connectionLimit: 10,
});

// Pre-created mysql2/promise Pool instance
import mysql from "mysql2/promise";
const pool = mysql.createPool({ host: "localhost", database: "mydb" });
const driver = new Mysql2Driver(pool);
```

### Convenience Helper

For quick setup, use the `createAdapter` shortcut that creates both the driver and `DbSpace` in one call:

```typescript
import { createAdapter } from "@atscript/db-mysql";

const db = createAdapter("mysql://root:pass@localhost:3306/mydb");
```

You can pass additional pool options as the second argument:

```typescript
const db = createAdapter("mysql://localhost:3306/mydb", { connectionLimit: 20 });
```

### Plugin Registration

To use MySQL-specific annotations (`@db.mysql.*`), register the plugin in your Atscript configuration:

```typescript
import ts from "@atscript/typescript";
import { dbPlugin } from "@atscript/db/plugin";
import mysql from "@atscript/db-mysql/plugin";

export default {
  plugins: [ts(), dbPlugin(), mysql()],
};
```

`dbPlugin()` is **required** — it registers all portable `@db.*` annotations. The MySQL plugin (`mysql()`) is optional and only needed if you use `@db.mysql.engine`, `@db.mysql.charset`, `@db.mysql.collate`, `@db.mysql.unsigned`, `@db.mysql.type`, or `@db.mysql.onUpdate`. See [Setup](/guide/setup) for full configuration details.

## MySQL-Specific Annotations

These annotations opt into MySQL-specific behavior. Files using only portable `@db.*` annotations remain adapter-agnostic.

| Annotation                      | Level            | Purpose                                                          |
| ------------------------------- | ---------------- | ---------------------------------------------------------------- |
| `@db.mysql.engine "ENGINE"`     | Interface        | Storage engine (default: `InnoDB`)                               |
| `@db.mysql.charset "CHARSET"`   | Interface, Field | Character set (default: `utf8mb4`)                               |
| `@db.mysql.collate "COLLATION"` | Interface, Field | Native MySQL collation (overrides portable `@db.column.collate`) |
| `@db.mysql.unsigned`            | Field            | Unsigned integer modifier                                        |
| `@db.mysql.type "TYPE"`         | Field            | Override the native column type (e.g., `"MEDIUMTEXT"`)           |
| `@db.mysql.onUpdate "EXPR"`     | Field            | ON UPDATE expression (e.g., `"CURRENT_TIMESTAMP"`)               |

Example:

```atscript
@db.mysql.engine "InnoDB"
@db.mysql.charset "utf8mb4"
@db.table "users"
export interface User {
  @meta.id
  @db.default.increment
  id: number.int

  @db.mysql.collate "utf8mb4_turkish_ci"
  name: string

  @db.mysql.unsigned
  age: number.int

  @db.mysql.type "MEDIUMTEXT"
  bio: string

  @db.default.now
  @db.mysql.onUpdate "CURRENT_TIMESTAMP"
  updatedAt: number.timestamp
}
```

## Type Mapping

| Atscript Type                         | MySQL Type                                | Notes                                                                                         |
| ------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `string`                              | `TEXT`                                    | `VARCHAR(N)` when `@expect.maxLength` is set; `VARCHAR(255)` for PKs and fields with defaults |
| `string` with `char` tag              | `CHAR(1)`                                 |                                                                                               |
| `string` with maxLength > 65535       | `LONGTEXT`                                |                                                                                               |
| `number`                              | `DOUBLE`                                  |                                                                                               |
| `number` (integer tags)               | `TINYINT` / `SMALLINT` / `INT` / `BIGINT` | Based on int8/int16/int32/int64 tags                                                          |
| `number` with `@db.mysql.unsigned`    | `INT UNSIGNED` / `BIGINT UNSIGNED` / etc. | Appends `UNSIGNED` to the integer type                                                        |
| `number` with `@db.column.precision`  | `DECIMAL(p,s)`                            |                                                                                               |
| `number` with `@db.default.increment` | `BIGINT`                                  | `AUTO_INCREMENT`                                                                              |
| `number` with `@db.default.now`       | `TIMESTAMP`                               | `DEFAULT CURRENT_TIMESTAMP`                                                                   |
| `boolean`                             | `TINYINT(1)`                              | Stored as `0` / `1`                                                                           |
| `decimal`                             | `DECIMAL(p,s)`                            | Defaults to `DECIMAL(10,2)`                                                                   |
| Nested objects                        | Flattened `__` columns                    | `address.city` becomes `address__city`                                                        |
| `@db.json`                            | `JSON`                                    | Stored as a single JSON column                                                                |
| Arrays                                | `JSON`                                    |                                                                                               |
| `@db.default.uuid`                    | `CHAR(36)`                                | Generated client-side via `crypto.randomUUID()`                                               |
| `@db.search.vector`                   | `VECTOR(N)`                               | MySQL 9.0+; falls back to `JSON` on older versions                                            |

### Unsigned Integers

MySQL supports unsigned integer types natively. Use `@db.mysql.unsigned` or unsigned primitive tags to produce the appropriate column type:

| Atscript Tag      | MySQL Type          |
| ----------------- | ------------------- |
| `uint8` / `byte`  | `TINYINT UNSIGNED`  |
| `uint16` / `port` | `SMALLINT UNSIGNED` |
| `uint32`          | `INT UNSIGNED`      |
| `uint64`          | `BIGINT UNSIGNED`   |

These can also be triggered by combining an integer primitive with `@db.mysql.unsigned`:

```atscript
@db.mysql.unsigned
viewCount: number.int   // → INT UNSIGNED
```

## Table Options

MySQL tables support table-level options that control the storage engine, character set, and collation. Defaults are applied automatically:

| Option        | Default              | Annotation                            |
| ------------- | -------------------- | ------------------------------------- |
| Engine        | `InnoDB`             | `@db.mysql.engine`                    |
| Character set | `utf8mb4`            | `@db.mysql.charset`                   |
| Collation     | `utf8mb4_unicode_ci` | `@db.mysql.collate` (interface-level) |

Schema sync detects changes to table options and applies them via `ALTER TABLE`:

```sql
ALTER TABLE `users` ENGINE = MyISAM, CHARACTER SET = latin1, COLLATE = latin1_swedish_ci
```

## FULLTEXT Indexes

MySQL supports native FULLTEXT indexes for text search. Annotate fields with `@db.index.fulltext` to create a FULLTEXT index:

```atscript
@db.table "articles"
export interface Article {
  @meta.id
  id: string

  @db.index.fulltext "search_idx"
  title: string

  @db.index.fulltext "search_idx"
  body: string
}
```

Multiple fields sharing the same index name are combined into a composite FULLTEXT index. The `search()` API generates `MATCH ... AGAINST` queries in natural language mode:

```typescript
const results = await articles.search("database optimization", {
  filter: { published: true },
  controls: { $limit: 20 },
});
```

This produces:

```sql
SELECT * FROM `articles`
WHERE `published` = ? AND MATCH(`title`, `body`) AGAINST(? IN NATURAL LANGUAGE MODE)
```

::: info FULLTEXT column ordering
MySQL FULLTEXT indexes do not support explicit column ordering. Atscript omits the ASC/DESC modifiers for FULLTEXT index fields automatically.
:::

## Vector Support (MySQL 9.0+)

MySQL 9.0 introduced native `VECTOR(N)` columns for storing fixed-dimension vectors. The adapter auto-detects the server version and uses native vector columns when available.

```atscript
@db.table "documents"
export interface Document {
  @meta.id
  id: string

  title: string

  @db.search.vector 1536 "cosine"
  embedding: number[]
}
```

### Distance Metrics

| Similarity         | MySQL Function           | Description             |
| ------------------ | ------------------------ | ----------------------- |
| `cosine` (default) | `VEC_DISTANCE_COSINE`    | Cosine distance         |
| `euclidean`        | `VEC_DISTANCE_EUCLIDEAN` | L2 / Euclidean distance |
| `dotProduct`       | `VEC_DISTANCE_DOT`       | Dot product distance    |

### Runtime Search

```typescript
const results = await table.vectorSearch(queryEmbedding, {
  filter: { status: "published" },
  controls: { $limit: 10, $threshold: 0.8 },
});
```

The `$threshold` parameter is a normalized similarity score (0--1) matching MongoDB Atlas semantics. The adapter converts it to the appropriate MySQL distance value internally (for cosine: `distance = 2 * (1 - score)`).

### Graceful Fallback

On MySQL versions prior to 9.0, vector fields are stored as `JSON` instead. The data is preserved, but indexed similarity search is not available — `vectorSearch()` will throw an error.

::: tip
Check your MySQL version with `SELECT VERSION()`. Vector support requires MySQL 9.0 or later.
:::

## In-Place Column Modification

The MySQL adapter sets `supportsColumnModify = true`, allowing column type changes, nullable changes, and default value changes to be applied in-place via `ALTER TABLE MODIFY COLUMN`:

```sql
ALTER TABLE `users` MODIFY COLUMN `age` INT UNSIGNED NOT NULL
```

This means most schema changes do not require full table recreation. You only need `@db.sync.method 'recreate'` for rare structural changes that MySQL cannot handle in-place (e.g., reordering primary key columns).

## Timestamp Handling

The adapter provides transparent timestamp conversion between JavaScript epoch milliseconds and MySQL `TIMESTAMP` columns:

- **Writes**: epoch milliseconds are converted to UTC datetime strings (`'YYYY-MM-DD HH:MM:SS'`)
- **Reads**: `TIMESTAMP`/`DATETIME` values are parsed back to epoch milliseconds

The driver configures `timezone: '+00:00'` on the connection pool, ensuring all timestamp operations use UTC consistently.

Use `@db.mysql.onUpdate "CURRENT_TIMESTAMP"` for auto-updating timestamps:

```atscript
@db.default.now
createdAt: number.timestamp

@db.default.now
@db.mysql.onUpdate "CURRENT_TIMESTAMP"
updatedAt: number.timestamp
```

The driver also applies custom type casting for `DECIMAL`/`NEWDECIMAL` columns, returning JavaScript numbers instead of strings.

## Foreign Key Sync

MySQL InnoDB enforces foreign key constraints natively. The adapter manages FK lifecycle during schema sync:

1. **Before column operations**: Existing FK constraints are dropped to unblock `ALTER TABLE` operations that would otherwise fail due to FK dependencies
2. **After column sync**: FK constraints are re-added based on the current schema definition

Standalone FK sync is available via `syncForeignKeys()`, which reconciles existing FK constraints against the desired schema — dropping stale constraints and adding missing ones.

When a foreign key constraint is violated, the adapter raises a `DbError` with the appropriate code:

- `CONFLICT` (errno 1062) — duplicate key / unique constraint violation
- `FK_VIOLATION` (errno 1451/1452) — foreign key constraint violation

## Batched Inserts

The `insertMany` method uses multi-row `INSERT INTO ... VALUES (...), (...)` for optimal performance. MySQL has a `max_allowed_packet` limit, so the adapter automatically chunks large batches (~60,000 parameters per chunk):

```typescript
// 10,000 rows with 8 columns = 80,000 params
// Adapter splits into 2 chunks: 7500 rows + 2500 rows
const result = await table.insertMany(largeDataset);
```

All rows within a batch insert are wrapped in a transaction for atomicity.

## Limitations

- **UUID generated client-side** — MySQL's `DEFAULT (UUID())` generates the value server-side, but the adapter cannot retrieve it via `insertId` (which only works for `AUTO_INCREMENT` columns). UUIDs are generated client-side via `crypto.randomUUID()` to ensure the generated ID is immediately available in the insert result
- **No transactional DDL** — DDL statements (`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`) cause an implicit `COMMIT`. Schema sync operations are not atomic; a failure mid-sync can leave the schema in a partially applied state
- **No RETURNING clause** — MySQL does not support `RETURNING` on INSERT. The adapter uses `insertId` from the result header for auto-increment columns and client-side IDs for everything else
- **Auto-increment gaps in batch inserts** — with `innodb_autoinc_lock_mode=2` (the MySQL 8.0+ default), concurrent inserts may cause gaps in auto-increment sequences during multi-row inserts
- **No native boolean** — booleans are stored as `TINYINT(1)` (`0`/`1`)
- **Key length prefix for TEXT indexes** — non-FULLTEXT indexes on string fields that map to `TEXT` columns require a key length prefix, which the adapter adds automatically (`(255)`)

## See Also

- [Adapter Overview](./) — feature comparison across all adapters
- [Schema Sync](/sync/) — automatic schema migration
- [CRUD Operations](/api/crud) — create, read, update, delete
- [Vector Search](/search/vector-search) — vector similarity search guide
- [Text Search](/search/) — fulltext search guide
