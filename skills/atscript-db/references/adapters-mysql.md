# adapters-mysql

`@atscript/db-mysql` — via `mysql2` (promise variant) using a connection pool. Supports VECTOR (MySQL 9+), FULLTEXT, utf8mb4, native FKs, and in-place column modify.

## Wiring

```ts
import { MysqlAdapter, Mysql2Driver, createAdapter } from "@atscript/db-mysql";

// URI string
const driver = new Mysql2Driver("mysql://root:@localhost:3306/app");

// PoolOptions
const driver2 = new Mysql2Driver({ host: "localhost", database: "app", connectionLimit: 10 });

// Pre-created mysql2/promise Pool (you must install typeCast yourself for cross-adapter consistency)
import mysql from "mysql2/promise";
const pool = mysql.createPool({ host: "localhost", database: "app" });
const driver3 = new Mysql2Driver(pool);

const db = new DbSpace(() => new MysqlAdapter(driver));

// One-liner
const db2 = createAdapter("mysql://root:@localhost:3306/app", { connectionLimit: 20 });
```

### Pool defaults

When `Mysql2Driver` creates the pool itself it sets:

- `timezone: "+00:00"` — write/read in UTC.
- `supportBigNumbers: true`, `bigNumberStrings: false`.
- `typeCast`: `TIMESTAMP` / `DATETIME` → epoch ms `number` (via `utcDatetimeToEpochMs`); `DECIMAL` / `NEWDECIMAL` → `number`.

Pre-created pools bypass these — install equivalents yourself for cross-adapter consistency.

## Register the plugin

```ts
import { MysqlPlugin } from "@atscript/db-mysql";
plugins: [ts(), dbPlugin(), MysqlPlugin()]; // unlocks @db.mysql.*
```

## Capabilities

| Capability                               | Notes                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Transactions                             | Native. InnoDB required (default).                                                                          |
| Native FKs (`supportsNativeForeignKeys`) | Yes. Referential actions pushed to `FOREIGN KEY (…) REFERENCES … ON DELETE …`.                              |
| Full-text search                         | `FULLTEXT` indexes for `@db.index.fulltext`. `search()` uses `MATCH … AGAINST` with mode `IN BOOLEAN MODE`. |
| Vector search                            | MySQL 9+ `VECTOR` type. `@db.search.vector N, 'cosine', 'idx'` → `VECTOR(N)` column.                        |
| Collation                                | Portable: `@db.column.collate`. Native: `@db.mysql.collate 'utf8mb4_unicode_ci'`.                           |
| Column modify                            | Yes — `ALTER TABLE MODIFY COLUMN …` in place.                                                               |
| Schemas                                  | Not supported — one schema per connection (database). `@db.schema` is ignored at runtime.                   |
| JSON                                     | `@db.json` → `JSON` (MySQL 5.7+).                                                                           |
| Native defaults                          | `supportsNativeValueDefaults: true` — DB emits `DEFAULT` clauses for static defaults.                       |

## `@db.mysql.*` annotations

| Annotation           | Target            | Args                  | Effect                                                                                                                                                     |
| -------------------- | ----------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@db.mysql.engine`   | Interface         | `engine: string`      | Storage engine (default `InnoDB`).                                                                                                                         |
| `@db.mysql.charset`  | Interface / Field | `charset: string`     | Character set (default `utf8mb4`).                                                                                                                         |
| `@db.mysql.collate`  | Interface / Field | `collation: string`   | Native collation (overrides `@db.column.collate`).                                                                                                         |
| `@db.mysql.unsigned` | Field             | —                     | `UNSIGNED` modifier on integer columns.                                                                                                                    |
| `@db.mysql.type`     | Field             | `type: string`        | Column type override (e.g. `MEDIUMTEXT`, `TINYTEXT`). Do **not** use for vectors — the adapter auto-emits `VECTOR(N)` for `@db.search.vector` on MySQL 9+. |
| `@db.mysql.onUpdate` | Field             | `'CURRENT_TIMESTAMP'` | `ON UPDATE` clause. Whitelist of exactly one value — `CURRENT_TIMESTAMP`.                                                                                  |

## utf8mb4 default

The adapter sets `charset=utf8mb4` on connection and uses it for new tables unless `@db.mysql.charset` overrides. Full Unicode (4-byte: emoji, etc.) works out of the box.

## Value formatters

MySQL `DATETIME`/`TIMESTAMP` columns are handled via `BaseDbAdapter.formatValue()` — epoch-ms numbers are converted to `YYYY-MM-DD HH:MM:SS` strings on write and back to numbers on read. Attribute `number.timestamp` types get this automatically when the generated SQL column type is a date type.

## Known limits

- No per-query schema selection — the pool is bound to one database.
- `VECTOR` requires MySQL 9.0+; older servers will reject the DDL.
- `FULLTEXT` requires InnoDB/MyISAM — default engine is InnoDB.
- `ON UPDATE CASCADE` on composite-FK columns requires InnoDB (default).
