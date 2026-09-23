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

| Capability                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transactions                             | Native. InnoDB required (default).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Native FKs (`supportsNativeForeignKeys`) | Yes. Referential actions pushed to `FOREIGN KEY (…) REFERENCES … ON DELETE …`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Full-text search                         | `FULLTEXT` indexes for `@db.index.fulltext`. `search()` uses `MATCH … AGAINST` with mode `IN BOOLEAN MODE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Vector search                            | MySQL 9+ `VECTOR` type. `@db.search.vector N, 'cosine', 'idx'` → `VECTOR(N)` column.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Geo search                               | Native. `db.geoPoint` → `POINT SRID 4326` (internal-format binary IO); `ST_Distance_Sphere`. SPATIAL index only on **required** fields (NOT NULL rule); optional fields warn+skip but stay searchable. → [geo-search.md](./geo-search.md)                                                                                                                                                                                                                                                                                                                               |
| Collation                                | Portable: `@db.column.collate`. Native: `@db.mysql.collate 'utf8mb4_unicode_ci'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Column modify                            | Yes — `ALTER TABLE MODIFY COLUMN …` in place. One `MODIFY` per column carrying the FULL definition (type, `NULL`/`NOT NULL`, `DEFAULT`, `COLLATE`, `ON UPDATE`, `AUTO_INCREMENT`) — nothing is silently reset (0.1.128).                                                                                                                                                                                                                                                                                                                                                |
| Schemas                                  | Not supported — one schema per connection (database). `@db.schema` is ignored at runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| JSON                                     | `@db.json` → `JSON` (MySQL 5.7+).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Calendar buckets                         | All units (since 0.1.132) via `CONVERT_TZ`. Non-UTC zones need tz tables loaded (`mysql_tzinfo_to_sql /usr/share/zoneinfo \| mysql -u root mysql`) AND MySQL ≥ 8.0.28 64-bit (post-2038). Lazy per-zone probe (cached per driver) → `BUCKET_TZ_UNAVAILABLE` 501 with the fix, never silent NULL/UTC. `UTC` needs neither. Tables from slim zoneinfo have no DST after 2037 → labels near midnight may differ. `SqlDialect.bucketAliasInHaving: true`.                                                                                                                   |
| Native defaults                          | `supportsNativeValueDefaults: true` — DB emits `DEFAULT` clauses for static defaults. No model default → NO `DEFAULT` clause (never `DEFAULT NULL`; `NOT NULL DEFAULT NULL` is ER 1067). Required column added to a populated table → invented type-aware default (`0`, `''`, `('')`, `('{}')`, `(ST_SRID(POINT(0, 0), 4326))`, `CURRENT_TIMESTAMP`) then immediately `ALTER COLUMN … DROP DEFAULT`; nullable→`NOT NULL` backfills NULLs first. TEXT/BLOB/JSON/geometry defaults use the expression form `DEFAULT ('…')` — MySQL ≥ 8.0.13 / MariaDB ≥ 10.2.1 (0.1.128). |
| Primary-key change                       | Empty table: one `ALTER TABLE … MODIFY <new key> NOT NULL[, MODIFY <demoted col w/o AUTO_INCREMENT>], DROP PRIMARY KEY, ADD PRIMARY KEY (…)`; `ADD COLUMN` never emits `AUTO_INCREMENT` (no helper index) — an added increment key column gets it in that statement, so a safe run leaves a valid schema; `pk` introspected from the `PRIMARY` constraint (`COLUMN_KEY='PRI'` lies on key-less tables). Populated → refused (0.1.128).                                                                                                                                  |

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
- **Index key length** (0.1.128): InnoDB key part ≤ 3072 bytes = **768 chars on utf8mb4** (1024 utf8mb3, 3072 latin1). Prefix rule per mapped type: `VARCHAR/CHAR(n)` within the limit → no prefix; longer → `(768)`; `TEXT`/`BLOB` → `(255)`; numeric/ENUM/JSON/VECTOR/geometry/FULLTEXT → never. A prefix on a UNIQUE index enforces uniqueness over the prefix only → give unique string fields `@expect.maxLength`. Live prefixes that differ (`STATISTICS.SUB_PART`; a value equal to the declared length counts as none) are rebuilt once. Composite keys > 3072 bytes in total fail as `ER_TOO_LONG_KEY` error entries.
- `SET FOREIGN_KEY_CHECKS=0` is session-scoped: drops of removed tables and `recreateTable` run every statement on ONE dedicated connection (0.1.128 fixed `recreateTable` using the pool).
- `explicit_defaults_for_timestamp=OFF`: a required `TIMESTAMP` without a model default gets a server-side `CURRENT_TIMESTAMP` default → perpetual default drift; declare `@db.default.now`.
