# adapters-sqlite

`@atscript/db-sqlite` — synchronous SQLite, wrapped in Promises. Default driver is `BetterSqlite3Driver`; `TSqliteDriver` is pluggable (e.g. `node:sqlite`, `sql.js` via a sync wrapper).

## Wiring

```ts
import { DbSpace } from "@atscript/db";
import { SqliteAdapter, BetterSqlite3Driver, createAdapter } from "@atscript/db-sqlite";

// Manual
const db = new DbSpace(() => new SqliteAdapter(new BetterSqlite3Driver("./app.db")));

// Or the one-liner
const db2 = createAdapter(":memory:", { verbose: console.log });
```

`BetterSqlite3Driver` accepts a path or a pre-created `Database` instance. Options: destructures `vector` / `loadExtensions`; everything else forwards to the `better-sqlite3` constructor.

- `vector: true` — load `sqlite-vec` on connect. Required for `@db.search.vector` to use a real `vec0` index (else falls back to JSON `TEXT`). Install peer: `pnpm add sqlite-vec`.
- `loadExtensions: string[]` — paths to loadable SQLite extensions.

```ts
const db = createAdapter("./app.db", { vector: true });
```

`hasVectorExt` is optional on `TSqliteDriver`. `BetterSqlite3Driver` always exposes it (true only when `sqlite-vec` loaded). If a custom driver omits it, the adapter probes via `SELECT vec_version()` once at sync.

## Capabilities

| Capability                                      | Status                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transactions                                    | Native `BEGIN` / `COMMIT` / `ROLLBACK`.                                                                                                                                 |
| Foreign keys (`supportsNativeForeignKeys`)      | Yes — `PRAGMA foreign_keys = ON` at connect. Referential actions enforced by SQLite.                                                                                    |
| Full-text search                                | **FTS5** virtual tables for `@db.index.fulltext`. `search()` uses `MATCH` with ranking.                                                                                 |
| Collation (`@db.column.collate`)                | `'binary'` → `BINARY`, `'nocase'` → `NOCASE`, `'unicode'` → `unicode61` tokenizer for FTS. Applied in `WHERE` via `COLLATE`.                                            |
| JSON columns (`@db.json`)                       | Stored as `TEXT`, read/written with `JSON()`/`json_extract`.                                                                                                            |
| Vector search                                   | **sqlite-vec extension** — `vec0` virtual shadow table per `@db.search.vector` field. KNN with cosine / l2; partition push-down via `@db.search.filter`.                |
| Geo search                                      | Haversine in SQL over the JSON `[lng, lat]` tuple (needs math functions — default in better-sqlite3). No physical index; scan-based. → [geo-search.md](./geo-search.md) |
| Decimal precision                               | SQLite has no native DECIMAL — stored as `NUMERIC`; precision is advisory.                                                                                              |
| Column modify in place (`supportsColumnModify`) | No — use `@db.sync.method 'recreate'` for type changes.                                                                                                                 |

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

## sqlite-vec / vec0 specifics

```atscript
@db.table 'documents'
interface Document {
    @meta.id @db.default.uuid id: string
    title: string

    @db.search.vector 1536, 'cosine'
    @db.search.vector.threshold 0.7
    embedding: number[]

    @db.search.filter 'embedding'
    tenant: string
}
```

```ts
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";
import { SqliteAdapter, BetterSqlite3Driver } from "@atscript/db-sqlite";

const db = new DbSpace(
  () => new SqliteAdapter(new BetterSqlite3Driver("./app.db", { vector: true })),
);
await syncSchema(db, [Document]);

const docs = db.getTable(Document);
await docs.insertOne({ title: "ship it", embedding: [0.1, 0.2 /* … 1536 dims */], tenant: "acme" });

const hits = await docs.vectorSearch(queryVec, {
  filter: { tenant: "acme" }, // partition push-down inside vec0
  controls: { $limit: 10, $threshold: 0.8 }, // query-time threshold overrides schema default
});
```

### Storage and sync

- Vector field is stored in the main table as `BLOB` (`Float32Array.buffer`). `formatValue` round-trips between JS `number[]` and the BLOB transparently.
- Each `@db.search.vector` field gets a vec0 shadow virtual table named `<table>__vec__<indexName>` (where `indexName` defaults to the field name).
- Three AFTER triggers on the main table keep the shadow in lockstep: `__ai` (insert), `__au` (update — delete-then-insert; vec0 has no upsert), `__ad` (delete). Sync is transactional with the parent write.
- Dimensions whitelist: see [annotations.md](annotations.md) (`@db.search.vector`).
- `similarity` maps to vec0 `distance_metric`: `cosine → cosine`, `euclidean → l2`, `dotProduct → cosine` (sqlite-vec has no native dot product — normalize vectors and use cosine).

### Search semantics

- `vectorSearch(vec, query?, indexName?)` and `vectorSearchWithCount(...)` implement KNN against the vec0 shadow, joined back to the main table on `rowid`.
- vec0 KNN always needs a `k`. The adapter computes `k = (limit + skip) × overfetch` where `overfetch = 4` when residual filters or a threshold are present (otherwise `1`). The trailing `LIMIT $limit OFFSET $skip` is applied after post-filtering.
- **Partition push-down**: top-level equality filters on fields declared `@db.search.filter '<indexName>'` are emitted inside the vec0 `WHERE` (`partition key` columns in the vec0 DDL). Non-partition filters and operator nodes (`$or`, `$gt`, …) become outer residual filters on the joined main row.
- **Threshold**: `controls.$threshold` overrides `@db.search.vector.threshold`. Score-to-distance follows postgres semantics: cosine `distance = 2*(1 − score)`; l2 passes through as a raw distance ceiling.
- Without `{ vector: true }`: `typeMapper` falls back to JSON `TEXT`, no vec0 table is created, and `vectorSearch` throws `Vector search requires the sqlite-vec extension`.
- Result rows carry `_distance` (ascending = more similar). `count` returned by `vectorSearchWithCount` is approximate when residual filters or threshold trim heavily — same caveat as pgvector.
- `getSearchIndexes()` returns one entry per fulltext **and** per vector index (`type: 'text' | 'vector'`).

### Identifier safety

Partition-key columns are emitted unquoted in the `vec0` DDL (the extension's parser rejects quoted identifiers in that position). The adapter validates these physical names against `^[A-Za-z_][A-Za-z0-9_]*$`; arbitrary `@db.column` overrides containing spaces or special chars will throw at sync time rather than risk injection.

## `$regex` translation

SQLite has no native regex operator. The dialect translates a restricted regex subset to `LIKE … ESCAPE '\'` and **throws** on anything outside that subset (silent fallbacks would corrupt pagination / sort / aggregation pushdown).

Supported:

- anchors `^` (start) and `$` (end) — only at the very ends of the pattern
- `.` (any single char) and `.*` (any run)
- escaped literals: `\.`, `\^`, `\$`, `\(`, `\)`, `\[`, `\]`, `\{`, `\}`, `\|`, `\/`, `\+`, `\*`, `\?`, `\-`, `\\`
- the `i` flag → `COLLATE NOCASE` (ASCII-only case-insensitivity)

Throws (`Unsupported regex …`):

- shorthand classes: `\d`, `\D`, `\w`, `\W`, `\s`, `\S`, `\b`, `\B`, `\n`, `\t`, …
- character classes: `[abc]`, `[^a-z]`
- alternation / groups: `a|b`, `(abc)`, `(?:abc)`, lookarounds
- quantifiers other than `.*`: `*`, `+`, `?`, `{n,m}` on anything but `.`

Callers building regex from user input should pass it through `escapeRegex(literal)` before wrapping with anchors / `.*`. Literal `%` and `_` round-trip safely — the translator escapes them for `LIKE`.

## Pragmas / concurrency / limits

- `PRAGMA foreign_keys = ON` (always); set WAL / `synchronous = NORMAL` via your driver options.
- `better-sqlite3` is single-writer — writes serialize per process. Avoid long `await` inside `withTransaction(fn)`.
- No `ALTER COLUMN`; type changes need `@db.sync.method 'recreate'` or `'drop'`.
- No native `CHECK` from annotations — validation is server-side.
- Vector search requires `sqlite-vec` peer + `{ vector: true }`; without it vectors degrade to `TEXT` and `vectorSearch` throws.

## `recreateTable()` (SQLite override)

`@db.sync.method 'recreate'` is overridden in `sqlite-adapter.ts`. Flow (one block per table):

1. Drop FTS5 + vec0 shadow tables (`syncIndexes()` recreates them).
2. `PRAGMA foreign_keys = OFF`; `PRAGMA legacy_alter_table = ON`.
3. Create temp with new schema: `<table>__tmp_<ts>`.
4. `INSERT INTO <tmp> (commonCols) SELECT … FROM <table>` — copies the intersection of old × new physical names. Non-optional, non-PK columns use `COALESCE(col, <default>)` (from `@db.default.value` or type default).
5. Rename old to `<table>__old_<ts>`, rename temp to `<table>`, `DROP TABLE <old>`.
6. Restore pragmas.

Column rename (`@db.column.renamed`) is handled in `syncColumns`, not here — `recreateTable` only copies the intersection of physical names.
