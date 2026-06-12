# adapters-postgres

`@atscript/db-postgres` — via `pg` (node-postgres) using a connection pool. Supports pgvector, CITEXT, tsvector FTS, and schemas.

## Wiring

```ts
import { PostgresAdapter, PgDriver, createAdapter } from "@atscript/db-postgres";

// URI string
const driver = new PgDriver("postgresql://user@localhost:5432/app");

// PoolConfig object
const driver2 = new PgDriver({ host: "localhost", database: "app", max: 10 });

// Pre-created pg.Pool (type parsers become the caller's responsibility)
import pg from "pg";
const pool = new pg.Pool({ connectionString: "..." });
const driver3 = new PgDriver(pool);

const db = new DbSpace(() => new PostgresAdapter(driver));

// One-liner
const db2 = createAdapter("postgresql://user@localhost:5432/app", { max: 20 });
```

### Type parsers

`PgDriver` installs per-pool custom type parsers (does not mutate global `pg.types`):

- `TIMESTAMP` / `TIMESTAMPTZ` → epoch ms `number` (not `Date`)
- `NUMERIC` → `number` (not `string`)
- `INT8` / `BIGINT` → `number` when in safe-integer range, else `string`

Cross-adapter consistency: epoch-ms numbers, `number` decimals. When you pass a pre-created `pg.Pool`, install equivalents yourself.

## Register the plugin

```ts
// atscript.config.mts
import { PostgresPlugin } from "@atscript/db-postgres";
plugins: [ts(), dbPlugin(), PostgresPlugin()]; // unlocks @db.pg.*
```

## Capabilities

| Capability                               | Notes                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transactions                             | Native. Pooled client checked out for the transaction's duration.                                                                                                                                                                                                                              |
| Native FKs (`supportsNativeForeignKeys`) | Yes. Referential actions pushed to `FOREIGN KEY (…) REFERENCES … ON DELETE …`.                                                                                                                                                                                                                 |
| Full-text search                         | `tsvector` GIN indexes for `@db.index.fulltext`. `search()` uses `websearch_to_tsquery`.                                                                                                                                                                                                       |
| Vector search                            | **pgvector extension required**. `@db.search.vector 1536, 'cosine', 'idx'` → `vector(1536)` column + HNSW index.                                                                                                                                                                               |
| Geo search                               | **PostGIS extension** (auto: `CREATE EXTENSION IF NOT EXISTS postgis` at sync). `db.geoPoint` → `geography(Point,4326)` + GiST index; `ST_Distance`/`ST_DWithin` (WGS84 spheroid). Without PostGIS → JSONB fallback, geo queries throw `GEO_NOT_SUPPORTED`. → [geo-search.md](./geo-search.md) |
| Collation                                | Portable: `@db.column.collate` → `binary: "C"`, `nocase: CITEXT column type` (no collation clause), `unicode: "und-x-icu"`. Override with native `@db.pg.collate 'tr-x-icu'`.                                                                                                                  |
| CITEXT                                   | `@db.pg.type 'CITEXT'` → case-insensitive text (requires `CREATE EXTENSION citext`).                                                                                                                                                                                                           |
| Column modify                            | Yes (`supportsColumnModify: true`) — `ALTER TABLE ALTER COLUMN … TYPE …` in place.                                                                                                                                                                                                             |
| Schemas                                  | `@db.schema 'auth'` (portable) or `@db.pg.schema 'auth'` (native override). Sync auto-creates the namespace on fresh DBs.                                                                                                                                                                      |
| JSON                                     | `@db.json` → `JSONB`.                                                                                                                                                                                                                                                                          |
| Native defaults                          | `supportsNativeValueDefaults: true`. `nativeDefaultFns`: `now`, `uuid`, `increment` — DB emits `DEFAULT` clauses for these.                                                                                                                                                                    |

## `@db.pg.*` annotations

| Annotation       | Target            | Args                | Effect                                                                     |
| ---------------- | ----------------- | ------------------- | -------------------------------------------------------------------------- |
| `@db.pg.type`    | Field             | `type: string`      | Native column type override: `CITEXT`, `INET`, `MACADDR`, `TSVECTOR`, etc. |
| `@db.pg.schema`  | Interface         | `schema: string`    | PG schema (default `public`).                                              |
| `@db.pg.collate` | Interface / Field | `collation: string` | Native collation (e.g. `tr-x-icu`). Overrides `@db.column.collate`.        |

## pgvector

```atscript
use '@atscript/db-postgres'
@db.table 'documents'
interface Document {
    @meta.id @db.default.uuid id: string
    @db.search.vector 1536, 'cosine', 'doc_vec'
    embedding: db.vector
    @db.search.filter 'doc_vec'
    category: string
}
```

- HNSW index: `CREATE INDEX atscript__doc_vec ON documents USING hnsw (embedding vector_cosine_ops)`.
- Distance ops (`postgres-adapter.ts:thresholdToDistance` / `similarityToPgOp`):

  | `similarity` | Operator | Threshold conversion          |
  | ------------ | -------- | ----------------------------- |
  | `cosine`     | `<=>`    | `distance = 2 * (1 - score)`  |
  | `euclidean`  | `<->`    | `distance = score` (raw max)  |
  | `dotProduct` | `<#>`    | `distance = -score` (negated) |

- Pre-filter fields (`@db.search.filter 'doc_vec'`) are added to the SQL `WHERE` before the vector op.
- Requires `CREATE EXTENSION IF NOT EXISTS vector;`.

## tsvector FTS

- `@db.index.fulltext 'search', 2` on two fields → one `tsvector_search` generated column + GIN index.
- `search(term, query, 'search')` runs `websearch_to_tsquery` and `ts_rank_cd` for ordering.

## Known limits

- Schemas are auto-created by sync (`CREATE SCHEMA IF NOT EXISTS` in `ensureTable()`); the role needs `CREATE` privilege on the database.
- `pgvector` extension must be enabled per database.
- `CITEXT` extension is auto-provisioned for `@db.collate 'nocase'`; manual install required for explicit `@db.pg.type 'CITEXT'`.
