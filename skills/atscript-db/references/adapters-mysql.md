# adapters-mysql

`@atscript/db-mysql` — via `mysql2` (promise variant) using a connection pool. Supports VECTOR (MySQL 9+), FULLTEXT, utf8mb4, native FKs, and in-place column modify.

## Wiring

```ts
import { MysqlAdapter, Mysql2Driver, createAdapter } from "@atscript/db-mysql";

// Manual
const driver = new Mysql2Driver({ uri: "mysql://root:@localhost:3306/app" });
const db = new DbSpace(() => new MysqlAdapter(driver));

// Or the one-liner
const db2 = createAdapter("mysql://root:@localhost:3306/app", { connectionLimit: 20 });
```

Options pass through to `mysql2.createPool`.

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

## `@db.mysql.*` annotations

| Annotation           | Target            | Args                 | Effect                                                                    |
| -------------------- | ----------------- | -------------------- | ------------------------------------------------------------------------- |
| `@db.mysql.engine`   | Interface         | `engine: string`     | Storage engine (default `InnoDB`).                                        |
| `@db.mysql.charset`  | Interface / Field | `charset: string`    | Character set (default `utf8mb4`).                                        |
| `@db.mysql.collate`  | Interface / Field | `collation: string`  | Native collation (overrides `@db.column.collate`).                        |
| `@db.mysql.unsigned` | Field             | —                    | `UNSIGNED` modifier on integer columns.                                   |
| `@db.mysql.type`     | Field             | `type: string`       | Column type override: `MEDIUMTEXT`, `TINYTEXT`, `ENUM(...)`, `VECTOR(N)`. |
| `@db.mysql.onUpdate` | Field             | `expression: string` | `ON UPDATE` clause (e.g. `CURRENT_TIMESTAMP`).                            |

## utf8mb4 default

The adapter sets `charset=utf8mb4` on connection and uses it for new tables unless `@db.mysql.charset` overrides. Full Unicode (4-byte: emoji, etc.) works out of the box.

## Value formatters

MySQL `DATETIME`/`TIMESTAMP` columns are handled via `BaseDbAdapter.formatValue()` — epoch-ms numbers are converted to `YYYY-MM-DD HH:MM:SS` strings on write and back to numbers on read. Attribute `number.timestamp` types get this automatically when the generated SQL column type is a date type.

## Known limits

- No per-query schema selection — the pool is bound to one database.
- `VECTOR` requires MySQL 9.0+; older servers will reject the DDL.
- `FULLTEXT` requires InnoDB/MyISAM — default engine is InnoDB.
- `ON UPDATE CASCADE` on composite-FK columns requires InnoDB (default).
