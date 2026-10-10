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

// Pre-created mysql2/promise Pool instance — give it the settings below
// (`jsonStrings: true` at least, since 0.1.155: a JSON string value read
// from a pool that parses JSON fails to parse again, or changes type)
import mysql from "mysql2/promise";
const pool = mysql.createPool({ host: "localhost", database: "mydb", jsonStrings: true });
const driver = new Mysql2Driver(pool);
```

### View reads skip unused joins {#view-join-pruning}

Since 0.1.153 a read of a managed view skips the `left` joins it does not need — MySQL never removes an unused outer join on its own, so a view's `COUNT(*)` otherwise probes every joined table per row. See [Unused joins are skipped](/views/querying-views#performance-unused-joins-are-skipped) for the rules; opt out with `new MysqlAdapter(driver, { viewJoinPruning: false })` or `createAdapter(uri, { viewJoinPruning: false })`.

### Strict mode per session {#strict-mode}

Since 0.1.148 the driver appends `STRICT_TRANS_TABLES` to the session `sql_mode` of every connection its pool opens (the server's own modes stay; a session that already has `STRICT_TRANS_TABLES` or `STRICT_ALL_TABLES` is left alone). A server with a non-strict default — Amazon RDS for MySQL defaults to `NO_ENGINE_SUBSTITUTION` — therefore rejects a missing `NOT NULL` value, an out-of-range number and an over-long string, in plain inserts and in [ignore mode](#insert-ignore) alike, instead of storing a coerced default. Pass `strictMode: false` as the second argument to keep the server's `sql_mode`:

```typescript
const driver = new Mysql2Driver("mysql://root:pass@localhost:3306/mydb", { strictMode: false });
// createAdapter(uri, { strictMode: false, ...poolOptions }) does the same
```

For a `Pool` you create yourself the driver adds the statement to connections the pool opens after the driver is constructed, and to a connection it opened earlier the first time that connection is acquired — so a pool warmed before the driver existed ends up uniformly strict. A custom `TMysqlDriver` is not touched — set the mode in your own connection init.

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

| Annotation                      | Level            | Purpose                                                                                     |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------- |
| `@db.mysql.engine "ENGINE"`     | Interface        | Storage engine (default: `InnoDB`). Allowed: `InnoDB`, `MyISAM`, `MEMORY`, `CSV`, `ARCHIVE` |
| `@db.mysql.charset "CHARSET"`   | Interface, Field | Character set (default: `utf8mb4`)                                                          |
| `@db.mysql.collate "COLLATION"` | Interface, Field | Native MySQL collation (overrides portable `@db.column.collate`)                            |
| `@db.mysql.unsigned`            | Field            | Unsigned integer modifier                                                                   |
| `@db.mysql.type "TYPE"`         | Field            | Override the native column type (e.g., `"MEDIUMTEXT"`)                                      |
| `@db.mysql.onUpdate "EXPR"`     | Field            | ON UPDATE expression. Only `"CURRENT_TIMESTAMP"` is accepted                                |

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
| `number` with `@db.default.now`       | `TIMESTAMP`                               | `DEFAULT CURRENT_TIMESTAMP`; whole seconds — see [Fractional seconds](#fractional-seconds)    |
| `boolean`                             | `TINYINT(1)`                              | Stored as `0` / `1`                                                                           |
| `decimal`                             | `DECIMAL(p,s)`                            | Defaults to `DECIMAL(10,2)`                                                                   |
| Nested objects                        | Flattened `__` columns                    | `address.city` becomes `address__city`                                                        |
| `T \| null`                           | The column of `T`, nullable               | Unions of objects are flattened; see [Nullable and Union Fields](/api/storage#unions)         |
| `@db.json`                            | `JSON`                                    | Stored as a single JSON column; descendant paths are not queryable (400 since 0.1.128)        |
| Arrays                                | `JSON`                                    | Same — select the column as a whole; filters accept only `$exists` (since 0.1.132)            |
| `@db.default.uuid`                    | `CHAR(36)`                                | Generated client-side via `crypto.randomUUID()`                                               |
| `@db.search.vector`                   | `VECTOR(N)`                               | MySQL 9.0+; falls back to `JSON` on older versions                                            |
| `db.geoPoint`                         | `POINT SRID 4326`                         | Native geographic point. See [Geo Search](/search/geo-search)                                 |

To filter, sort or group by a leaf inside a `@db.json` column, expose it as a [typed view field](/views/#reading-json-leaves).

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

**Integer members** cannot live in a FULLTEXT index (MySQL error 1283) and are left out of it; they are matched by exact number instead. A text-only search keeps the shape above (MySQL's relevance order applies). When the whole search term is a whole number and the table has a primary key, the adapter combines each arm's access path as a primary-key set, because an `OR` next to `MATCH` would force a full scan:

```sql
SELECT * FROM `tickets`
WHERE `id` IN (SELECT `id` FROM (
  SELECT `id` FROM `tickets` WHERE MATCH(`title`) AGAINST(? IN NATURAL LANGUAGE MODE)
  UNION SELECT `id` FROM `tickets` WHERE `ref_no` = ?
) AS `_atscript_search`)
```

A composite key uses a row-value `IN`; a table without a primary key falls back to a plain `OR`. A mixed text + number result has no relevance order — pass `$sort`. An index of integer members only creates no FULLTEXT index. See [Text Search — Integer fields](/search/#integer-fields-exact-number-match).

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

### Conversions are strict (since 0.1.140) {#strict-conversions}

Schema sync runs the statements that convert stored values — `MODIFY COLUMN`, the `NULL` backfill before `NOT NULL`, the primary-key rebuild and the `@db.sync.method 'recreate'` copy — with `STRICT_ALL_TABLES` added to the session `sql_mode`, and restores the session's previous mode afterwards. A value that does not convert fails the sync as an `error` entry and the table keeps its data:

- changing `code: string` to `code: number` fails on a stored `'abc'`;
- lowering `@expect.maxLength` below a stored value fails with `Data too long`.

A number column that becomes a `TIMESTAMP` / `DATETIME` (a field gaining `@db.default.now`, such as `number.timestamp` → `number.timestamp.created`) — or the text column an earlier version created for a `number.timestamp.created | null` — holds epoch milliseconds, which `MODIFY COLUMN` would read as `YYYYMMDDhhmmss`. Since 0.1.155 the sync converts it through a temporary column instead: each value becomes the UTC datetime the adapter writes for it (in a text column, a value that is not a number is read as a datetime, as `MODIFY COLUMN` would) (milliseconds dropped unless the column has fractional seconds), the old column is dropped and the new one takes its name and position. A value the type cannot hold (a `TIMESTAMP` before 1970-01-01 00:00:01 or after 2038-01-19 UTC), or a drop the engine refuses (a foreign key on the column, a unique index it would leave with duplicates), fails the sync with the old column kept. A column that is part of the primary key before and after the sync is not converted: the table's sync fails before any DDL — convert it manually. A column entering or leaving the key in the same sync is converted (before the key swap / after it).

Before 0.1.140 this depended on the server. A server whose `sql_mode` is not strict — Amazon RDS for MySQL defaults to `NO_ENGINE_SUBSTITUTION` — coerced `'abc'` to `0` and truncated text, and the sync reported success. Clean or migrate such values before changing the type. Your application's own connections are strict too since 0.1.148 ([Strict mode per session](#strict-mode)); with `strictMode: false` they keep the server's `sql_mode`.

### Column definitions (since 0.1.128)

`CREATE TABLE`, `ADD COLUMN` and `MODIFY COLUMN` all render a column through one definition builder, so a `MODIFY` never silently resets an attribute it did not mention:

- **No model default → no `DEFAULT` clause.** `DEFAULT NULL` is never emitted (it is the implicit default of a nullable column, and `NOT NULL DEFAULT NULL` is MySQL error 1067). Removing a `@db.default` from a required column renders as `MODIFY COLUMN … NOT NULL` without a `DEFAULT`.
- **Required column added to a populated table** gets an invented, **type-aware** default so existing rows can be filled — `0` for numeric, `''` for `VARCHAR`/`CHAR`, `('')` for `TEXT`/`BLOB`, `('{}')` for `JSON`, `(ST_SRID(POINT(0, 0), 4326))` for geometry, `CURRENT_TIMESTAMP` for `TIMESTAMP`/`DATETIME` — followed immediately by `ALTER TABLE … ALTER COLUMN … DROP DEFAULT`, so the live column ends in the canonical "no default" state whatever the `sql_mode`.
- **Nullable → `NOT NULL`** backfills existing `NULL`s first (`UPDATE … SET col = <model default or type default> WHERE col IS NULL`) — strict `sql_mode` would otherwise reject the `MODIFY`.
- **Several changes on one column** (type + nullability + default) collapse into **one** `MODIFY COLUMN` carrying the full definition — `DEFAULT`, `COLLATE` and `ON UPDATE` are preserved.
- **Expression defaults** — `TEXT`/`BLOB`/`JSON`/geometry columns can only carry a default in the expression form `DEFAULT ('…')`, which requires **MySQL ≥ 8.0.13** (MariaDB ≥ 10.2.1). Older servers cannot default those types at all.
- **Primary-key change** on an empty table is one statement: `ALTER TABLE … MODIFY <new key columns> NOT NULL[, MODIFY <demoted column without AUTO_INCREMENT>], DROP PRIMARY KEY, ADD PRIMARY KEY (…)`. The primary key is introspected from the `PRIMARY` constraint, not from `COLUMN_KEY = 'PRI'` (which MySQL also reports for the first `NOT NULL UNIQUE` index of a key-less table).
- **`AUTO_INCREMENT` is never emitted by `ADD COLUMN`.** MySQL only accepts it together with a key in the same statement, so an increment column joining the key is added as a plain `NOT NULL` column, its `MODIFY` is left to the key rebuild, and the rebuild statement above declares `AUTO_INCREMENT` together with `ADD PRIMARY KEY`. There is no temporary helper index; a `--safe` run (rebuild skipped) therefore leaves a valid schema and the next executing run completes the swap. A `@db.default.increment` column that is not a key column consequently gets no `AUTO_INCREMENT` when added to an existing table (the compiler warns about `@db.default.increment` without `@meta.id`).

Under `explicit_defaults_for_timestamp = OFF` a required `TIMESTAMP` column without a model default (only reachable through `@db.mysql.type "TIMESTAMP"`) receives an implicit `CURRENT_TIMESTAMP` default from the server, which the diff then reports as a default change on every run — declare `@db.default.now` on such columns.

## Driver Type Casting

`Mysql2Driver` installs a custom `typeCast` and a few pool defaults so query results are predictable JS values, not driver-default strings:

- **`TIMESTAMP` / `DATETIME` → `number`** (epoch milliseconds). Reads parse the UTC datetime string back to a number, fractional seconds included; writes accept epoch ms and emit `'YYYY-MM-DD HH:MM:SS'`, plus `.fff` on a column with fractional seconds (see below).
- **`DECIMAL` / `NEWDECIMAL` → `number`** instead of `string`. Be aware that values outside JS safe-number range may lose precision — keep `decimal` columns within `~15` significant digits if you rely on this.
- **`timezone: '+00:00'`** is set on the pool so all timestamp operations are UTC.
- **`jsonStrings: true`** (since 0.1.155, and the same in the `typeCast`) — `JSON` columns come back as text, as on MariaDB, and atscript-db parses them, so a JSON value that is a string stays a string.
- **`supportBigNumbers: true`**, **`bigNumberStrings: false`** — `BIGINT` values within `Number.MAX_SAFE_INTEGER` come back as `number`; out-of-range values come back as **`string`** (preserves full precision without truncation). Coerce to `BigInt` yourself if you need arithmetic on those values.

If you pre-create your own `mysql2/promise` `Pool` and pass it to `Mysql2Driver`, type casting becomes the caller's responsibility — replicate the settings above if you want the same behavior.

Use `@db.mysql.onUpdate "CURRENT_TIMESTAMP"` for auto-updating timestamps:

```atscript
@db.default.now
createdAt: number.timestamp

@db.default.now
@db.mysql.onUpdate "CURRENT_TIMESTAMP"
updatedAt: number.timestamp
```

### Fractional seconds {#fractional-seconds}

A `number` with `@db.default.now` is a plain `TIMESTAMP`: whole seconds, and the milliseconds of a value you write are dropped (truncated, never rounded up). For millisecond precision declare the column type:

```atscript
@db.default.now
@db.mysql.type "TIMESTAMP(3)"
createdAt: number.timestamp

@db.mysql.type "DATETIME(3)"
seenAt?: number
```

A `number` field whose `@db.mysql.type` is `TIMESTAMP(n)` / `DATETIME(n)` (with or without `@db.default.now`) is written as a UTC datetime string with `n` fractional digits (up to milliseconds) and read back as epoch ms with its milliseconds. `DEFAULT` and `ON UPDATE` render as `CURRENT_TIMESTAMP(n)`, which MySQL requires for such a column. A `@db.mysql.type` that is not a date type (say `BIGINT`) keeps the number as is, `@db.default.now` included.

## Foreign Key Sync

MySQL InnoDB enforces foreign key constraints natively. The adapter manages FK lifecycle during schema sync:

1. **Before column operations**: Existing FK constraints are dropped to unblock `ALTER TABLE` operations that would otherwise fail due to FK dependencies
2. **After column sync**: FK constraints are re-added based on the current schema definition

Since 0.1.128 tables are synced parents-first, a foreign-key cycle is created with its inline constraints deferred to the FK pass, removed tables are dropped children-first (`FOREIGN_KEY_CHECKS=0` on a dedicated connection — the same connection `recreateTable` now uses for its whole copy-and-swap), and a removed table that an **unmanaged** table still references is reported as an `error` entry instead of being dropped underneath the constraint.

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

All rows within a batch insert are wrapped in a transaction for atomicity. The column list is the union of every row's fields, and a row that omits a column gets its `DEFAULT` — up to 0.1.131 columns absent from the first row were dropped from the whole batch (see [Insert Many](/api/crud#insert-many)).

## Calendar Buckets {#calendar-buckets}

[Calendar buckets](/api/calendar-buckets) (since 0.1.132) convert timestamps with `CONVERT_TZ`, which needs two things from the server for zones other than UTC:

- **Time zone tables.** MySQL ships them empty. Load them from the system zoneinfo, and reload after tzdata updates:

  ```bash
  mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -u root mysql
  ```

  On a managed service, check how it provides named time zones.

- **MySQL 8.0.28 or later, 64-bit.** Earlier versions cannot convert instants after 2038.

`UTC` buckets need neither. The adapter probes each zone once per driver before its first bucket query. When the tables lack the zone or the server cannot convert post-2038 instants, the query fails with `BUCKET_TZ_UNAVAILABLE` (HTTP 501) and a message naming the fix — never with `NULL` or UTC labels:

```
MySQL cannot convert to time zone "Europe/Berlin": its time zone tables are not loaded or lack this zone — load them with mysql_tzinfo_to_sql
```

::: warning Zone tables built from "slim" zoneinfo
Some distributions ship "slim" zoneinfo files that describe DST after 2037 with a rule instead of explicit transitions. `mysql_tzinfo_to_sql` ignores that rule, so the loaded tables have no DST after 2037, and labels of timestamps near local midnight (for `hour` buckets, near any DST change) after 2037 can differ from the other adapters. Load the tables from "fat" zoneinfo if you bucket far-future dates.
:::

## Aggregate Expressions {#aggregate-expressions}

[Arithmetic and `first` / `last`](/api/aggregation#arithmetic-expressions) run in SQL. `first` / `last` need window functions, so **MySQL 8.0+** (the same requirement as per-parent `$with` limits). A double overflow (errno 1690) is `INVALID_QUERY` (`Arithmetic overflow`), not a 500.

## Views

Managed [views](/views/) are created with `CREATE OR REPLACE VIEW`.

Since 0.1.147 a [first-row join](/views/#first-row-joins) renders as a correlated scalar subquery in the join's `ON` (no window functions):

```sql
LEFT JOIN `issues` AS `OldestOpenIssue`
  ON `OldestOpenIssue`.`id` = (SELECT `OldestOpenIssue`.`id` FROM `issues` AS `OldestOpenIssue`
      WHERE <condition> ORDER BY `OldestOpenIssue`.`raised_at` ASC, `OldestOpenIssue`.`id` ASC LIMIT 1)
```

It runs once per entry row; an index on the condition's join key plus the order keys (`(ticket_id, raised_at, id)`) keeps each lookup an index scan.

[Computed columns](/views/computed-columns) cast every field and literal operand with `CAST(x AS DOUBLE)` and divide with `NULLIF(divisor, 0)`, so `7 / 2 = 3.5` and division by zero is `NULL`. `DOUBLE` (not `DECIMAL`) avoids `div_precision_increment` rounding. `CAST … AS DOUBLE` needs MySQL 8.0.17+; on MariaDB, plan on 10.4.5 or later for views with computed columns. That is a conservative minimum: it is the release that documents `CAST … AS DOUBLE` / `FLOAT`, and older MariaDB lines are not tested. A result outside the `DOUBLE` range fails the read with `DOUBLE value is out of range`. In a grouped view a computed column over a JSON-extracted dimension reads `MIN(<extract>)` — the value of the group — because `ONLY_FULL_GROUP_BY` rejects an expression over the raw JSON column.

## Derived Columns

A [`@db.column.derived`](/api/storage#derived-columns) field (since 0.1.141) is a `GENERATED ALWAYS AS (…) VIRTUAL` column over `JSON_TYPE()` / `JSON_EXTRACT()` of its source (booleans compare the unquoted value to `'true'`; numbers are `+ 0`). A string leaf maps to `VARCHAR(255)` instead of `TEXT` so a plain or unique index over it needs no key prefix; `@db.column.collate` goes between the type and the generated clause. The definition never carries `NOT NULL` or `DEFAULT`, and in-place `MODIFY COLUMN` is never used on it: a changed extraction is `DROP COLUMN` + `ADD COLUMN` (managed indexes dropped first). Introspection reads `INFORMATION_SCHEMA.COLUMNS.EXTRA` (`VIRTUAL GENERATED` / `STORED GENERATED`, MariaDB included); a `recreateTable` copies every column but the generated ones.

## Relational Predicates {#relational-predicates}

[`$some` / `$none` filters](/api/queries#relational-filters) (since 0.1.147) render as correlated `EXISTS (SELECT 1 FROM … WHERE …)` / `NOT EXISTS` subqueries, in reads and in mutation filters.

**Writes that read their own table.** MySQL refuses an `UPDATE` or `DELETE` whose subquery reads the table being changed (error 1093, `ER_UPDATE_TABLE_USED`) — for example `updateMany` on tickets filtered by `parent=$some(status=open)`, a relation from tickets to tickets. When a predicate at any depth reads the statement's own table, the adapter rewrites the statement to

```sql
UPDATE `tickets` SET … WHERE `key` IN (SELECT * FROM (SELECT DISTINCT `key` FROM `tickets` WHERE <filter>) AS _rfm)
```

which MySQL materializes first. The rewrite needs a primary key; a table without one fails with `REL_FILTER_NOT_SUPPORTED` — `MySQL cannot update or delete "<table>" by a relational predicate that reads the table itself without a primary key`. Reads are never rewritten.

**Indexes.** InnoDB creates an index for every foreign-key constraint, so the foreign-key columns that schema sync constrains — on the `@db.rel.from` side and in `@db.rel.via` junctions — are already indexed. Index them yourself only when the constraint is not managed by schema sync.

## Conflict-ignoring inserts {#insert-ignore}

`insertMany(rows, { onConflict: "ignore" })` ([CRUD](/api/crud#insert-ignore)) first sends the chunk as ONE optimistic multi-row `INSERT`, so an all-new batch is a single statement per chunk. Only when that `INSERT` hits a duplicate key (errno 1062 / 1586) does the adapter look up the chunk's primary-key and unique-index values with ONE `SELECT`, skip the rows whose key is already stored, and send the survivors as one more multi-row `INSERT`, so dense duplicates cost three statements per chunk (the failed `INSERT`, the `SELECT`, the survivor `INSERT`). Only if the survivor `INSERT` still collides (a concurrent writer, or a collation-equal value) is the chunk **bisected**: each half is retried, recursively, until a single colliding row is skipped. A chunk that mixes rows with and without an explicit auto-increment primary key is cut into consecutive runs of one kind, one statement per run, executed in input order (so an earlier row wins a unique collision, even under a case-insensitive collation), because MySQL reports only the first generated id and an explicit value above the counter moves it; reported ids are always in input order. Generated ids follow the session's `@@auto_increment_increment`: a multi-row statement of generated ids reads it once per call (one extra `SELECT @@auto_increment_increment`) and reports `first + i * increment`. The adapter deliberately does **not** use `INSERT IGNORE` (it downgrades `NOT NULL`, foreign-key and truncation errors to warnings) or `ON DUPLICATE KEY UPDATE` (a no-op update is indistinguishable from an insert in the affected-rows count). Auto-increment values advance for skipped rows (gaps).

- **Inside a caller's transaction (since 0.1.153) the lookup comes first.** A failed duplicate `INSERT` leaves InnoDB's **shared** lock on the stored row until `COMMIT`; if two transactions ignore-insert the same stored row and then update it, each waits for the other's shared lock and one dies with a deadlock. So when the call joins a transaction you opened (`withTransaction` around it), the adapter first runs the key `SELECT` (a non-locking consistent read — no lock on any stored row), then inserts only the missing rows, sorted by primary key, in one `INSERT`: an all-new batch costs two statements there instead of one. Standalone calls keep the optimistic single `INSERT` (their transaction ends with the call, so the lock is gone before anything else runs). A row committed by another transaction after your transaction's snapshot is invisible to the lookup; its `INSERT` collides, the bisect skips it, and that one row keeps the shared lock.
- **`lockConflicts: true`** ([CRUD](/api/crud#insert-ignore-lock), since 0.1.153) additionally locks the stored rows the lookup found: `SELECT <pk> … WHERE <pk> IN (<found keys>) ORDER BY <pk> FOR UPDATE` — by the unique key instead for a row that collided only on a unique index, one statement per key. Only keys that exist are locked, so InnoDB takes record locks and no gap locks (a `FOR UPDATE` on missing keys would take gap locks, and two inserters of the same new key would then deadlock on insert intention). Concurrent callers doing the same queue on those rows. Two limits: a row that collides only at `INSERT` time (committed after your snapshot) keeps the failed `INSERT`'s shared lock, not an exclusive one; and a row deleted after your snapshot still looks stored to the lookup, so it is reported as a conflict (and its key, now missing, is locked with a gap lock). Lock order is ascending per insert chunk.
- **Deadlocks and lock wait timeouts** (errno 1213 / 1205) throw `DbError("DEADLOCK" | "LOCK_TIMEOUT")` with `retryable: true` on every write since 0.1.153 — retry the whole transaction ([Transactions](/api/transactions#retrying)).
- **A generated id that collides is an error, not a conflict.** A duplicate on `PRIMARY` for a row that carried no primary key (a generated id, for instance an exhausted `AUTO_INCREMENT`) is rethrown as `CONFLICT`; it is never silently skipped. Duplicates of an explicit key or a unique index are the ignorable ones.
- **`NO_AUTO_VALUE_ON_ZERO`.** When the session `sql_mode` contains it, an explicit `0` / `"0"` primary key is a value, not a request for a generated id. The adapter reads `sql_mode` once per call (only when a row carries such a `0`), on the same connection as the inserts.
- **Strict `sql_mode` is assumed.** Ignore mode — like every write of this adapter — assumes `STRICT_TRANS_TABLES` (the MySQL 8 default) or `STRICT_ALL_TABLES`: a non-strict mode silently coerces a `NOT NULL` violation to the column default instead of failing. `Mysql2Driver` makes every session strict by default ([Strict mode per session](#strict-mode)), so the assumption holds. Only when you opt out with `strictMode: false` (or use another driver) and the adapter has a logger does it warn once per driver — at the first schema operation or insert-ignore — if the session `sql_mode` lacks a strict mode.

## Limitations

- **UUID generated client-side** — MySQL's `DEFAULT (UUID())` generates the value server-side, but the adapter cannot retrieve it via `insertId` (which only works for `AUTO_INCREMENT` columns). UUIDs are generated client-side via `crypto.randomUUID()` to ensure the generated ID is immediately available in the insert result
- **No transactional DDL** — DDL statements (`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`) cause an implicit `COMMIT`. Schema sync operations are not atomic; a failure mid-sync can leave the schema in a partially applied state
- **No RETURNING clause** — MySQL does not support `RETURNING` on INSERT. The adapter uses `insertId` from the result header for auto-increment columns and client-side IDs for everything else
- **Auto-increment gaps in batch inserts** — with `innodb_autoinc_lock_mode=2` (the MySQL 8.0+ default), concurrent inserts may cause gaps in auto-increment sequences during multi-row inserts
- **No native boolean** — booleans are stored as `TINYINT(1)` (`0`/`1`)
- **Key length prefix** — InnoDB limits an index key part to 3072 bytes (`ROW_FORMAT=DYNAMIC`/`COMPRESSED`, the default since 5.7.7), i.e. **768 characters on `utf8mb4`** (1024 on `utf8mb3`, 3072 on `latin1`). Since 0.1.128 the adapter derives the prefix from the **mapped column type**: `VARCHAR(n)`/`CHAR(n)` within the limit get **no prefix**; longer ones get the full limit (`(768)` on utf8mb4); `TEXT`/`BLOB` families always get `(255)`; numeric, `ENUM`, `JSON`, `VECTOR`, geometry and `FULLTEXT` members never get one. Earlier releases put `(255)` on every string member — which failed on `VARCHAR(128)`/`CHAR(1)` (`ER_WRONG_SUB_KEY`) and, on a **unique** index over a `VARCHAR(300)`, silently enforced uniqueness over the first 255 characters only. Live indexes whose prefix differs from the rule (`INFORMATION_SCHEMA.STATISTICS.SUB_PART`, with a prefix equal to the column's declared length treated as none) are rebuilt once. Declare `@expect.maxLength` on unique string fields so they map to `VARCHAR(n)` and are indexed in full; a composite index whose members exceed 3072 bytes in total fails with the engine's `ER_TOO_LONG_KEY` as an `error` entry

## See Also

- [Adapter Overview](./) — feature comparison across all adapters
- [Schema Sync](/sync/) — automatic schema migration
- [CRUD Operations](/api/crud) — create, read, update, delete
- [Vector Search](/search/vector-search) — vector similarity search guide
- [Text Search](/search/) — fulltext search guide
