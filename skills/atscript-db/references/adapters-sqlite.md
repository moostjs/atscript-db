# adapters-sqlite

`@atscript/db-sqlite` — via `better-sqlite3` (synchronous driver, wrapped in Promises).

## Wiring

```ts
import { DbSpace } from "@atscript/db";
import { SqliteAdapter, BetterSqlite3Driver, createAdapter } from "@atscript/db-sqlite";

// Manual
const db = new DbSpace(() => new SqliteAdapter(new BetterSqlite3Driver("./app.db")));

// Or the one-liner
const db2 = createAdapter(":memory:", { verbose: console.log });
```

The second arg to `BetterSqlite3Driver` forwards to the `better-sqlite3` constructor (`{ readonly, timeout, verbose, fileMustExist }`).

## Capabilities

| Capability                                      | Status                                                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Transactions                                    | Native `BEGIN` / `COMMIT` / `ROLLBACK`.                                                                                      |
| Foreign keys (`supportsNativeForeignKeys`)      | Yes — `PRAGMA foreign_keys = ON` at connect. Referential actions enforced by SQLite.                                         |
| Full-text search                                | **FTS5** virtual tables for `@db.index.fulltext`. `search()` uses `MATCH` with ranking.                                      |
| Collation (`@db.column.collate`)                | `'binary'` → `BINARY`, `'nocase'` → `NOCASE`, `'unicode'` → `unicode61` tokenizer for FTS. Applied in `WHERE` via `COLLATE`. |
| JSON columns (`@db.json`)                       | Stored as `TEXT`, read/written with `JSON()`/`json_extract`.                                                                 |
| Vector search                                   | Not supported.                                                                                                               |
| Decimal precision                               | SQLite has no native DECIMAL — stored as `NUMERIC`; precision is advisory.                                                   |
| Column modify in place (`supportsColumnModify`) | No — use `@db.sync.method 'recreate'` for type changes.                                                                      |

## In-memory for tests

```ts
const db = createAdapter(":memory:");
await syncSchema(db, allTypes);
// Fresh DB per spec — WeakMap caching in DbSpace is scoped to this instance.
```

Each `DbSpace` instance owns its adapters; create a new space per test to guarantee isolation.

## FTS5 specifics

- `@db.index.fulltext 'search', 3` on one field + `@db.index.fulltext 'search', 1` on another → one FTS5 virtual table backing both with rank weighting.
- `search('term', query, indexName)` calls `SELECT rowid FROM <fts> WHERE <fts> MATCH 'term' ORDER BY rank`; the outer query applies `filter` / `$sort` / pagination.
- `isSearchable()` → `true` when any `@db.index.fulltext` is declared.

## Pragmas / defaults

- `PRAGMA foreign_keys = ON` — always set so `@db.rel.onDelete` works.
- `PRAGMA journal_mode = WAL` — recommended for production; set explicitly in your driver options if needed.
- `PRAGMA synchronous = NORMAL` — default for WAL; leave at the driver's default unless tuning.

## Concurrency caveats

- `better-sqlite3` is single-writer. Parallel writes serialize at the process level.
- The `withTransaction(fn)` wrapper is synchronous under the hood; avoid long-running `await` inside to prevent blocking.
- For horizontal scale, use WAL + accept write contention, or switch to PostgreSQL.

## Migrating data

`@db.sync.method 'recreate'` path (generic in `BaseDbAdapter.recreateTable()`):

1. `CREATE TABLE <name>_new (...)`
2. `INSERT INTO <name>_new SELECT … FROM <name>` (column mapping honors `@db.column.renamed`)
3. `DROP TABLE <name>`
4. `ALTER TABLE <name>_new RENAME TO <name>`
5. Recreate indexes.

Runs in one transaction per table.

## Known limits

- No `ALTER COLUMN` — all type changes go through `recreate` or `drop`.
- No native `CHECK` constraints from Atscript annotations (validation runs server-side via the Atscript validator).
- No native vector search — use the PostgreSQL or MongoDB adapter when that's required.
