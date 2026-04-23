# adapters-postgres

`@atscript/db-postgres` — via `pg` (node-postgres) using a connection pool. Supports pgvector, CITEXT, tsvector FTS, and schemas.

## Wiring

```ts
import { PostgresAdapter, PgDriver, createAdapter } from "@atscript/db-postgres";

// Manual
const driver = new PgDriver({ connectionString: "postgresql://user@localhost:5432/app" });
const db = new DbSpace(() => new PostgresAdapter(driver));

// Or the one-liner
const db2 = createAdapter("postgresql://user@localhost:5432/app", { max: 20 });
```

Options passed to `PgDriver` forward to `pg.Pool`: `max`, `idleTimeoutMillis`, `connectionTimeoutMillis`, `ssl`, etc.

## Register the plugin

```ts
// atscript.config.mts
import { PostgresPlugin } from "@atscript/db-postgres";
plugins: [ts(), dbPlugin(), PostgresPlugin()]; // unlocks @db.pg.*
```

## Capabilities

| Capability                               | Notes                                                                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transactions                             | Native. Pooled client checked out for the transaction's duration.                                                                                                             |
| Native FKs (`supportsNativeForeignKeys`) | Yes. Referential actions pushed to `FOREIGN KEY (…) REFERENCES … ON DELETE …`.                                                                                                |
| Full-text search                         | `tsvector` GIN indexes for `@db.index.fulltext`. `search()` uses `websearch_to_tsquery`.                                                                                      |
| Vector search                            | **pgvector extension required**. `@db.search.vector 1536, 'cosine', 'idx'` → `vector(1536)` column + HNSW index.                                                              |
| Collation                                | Portable: `@db.column.collate` → `binary: "C"`, `nocase: CITEXT column type` (no collation clause), `unicode: "und-x-icu"`. Override with native `@db.pg.collate 'tr-x-icu'`. |
| CITEXT                                   | `@db.pg.type 'CITEXT'` → case-insensitive text (requires `CREATE EXTENSION citext`).                                                                                          |
| Column modify                            | Yes (`supportsColumnModify: true`) — `ALTER TABLE ALTER COLUMN … TYPE …` in place.                                                                                            |
| Schemas                                  | `@db.schema 'auth'` (portable) or `@db.pg.schema 'auth'` (native override).                                                                                                   |
| JSON                                     | `@db.json` → `JSONB`.                                                                                                                                                         |

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

- The adapter creates an HNSW index: `CREATE INDEX atscript__doc_vec ON documents USING hnsw (embedding vector_cosine_ops)`.
- `vectorSearch(vec, query, 'doc_vec')` uses `<=>` (cosine), `<->` (euclidean), `<#>` (inner product).
- Pre-filter fields (`@db.search.filter 'doc_vec'`) are added to the SQL `WHERE` before the vector op.
- Requires the extension: `CREATE EXTENSION IF NOT EXISTS vector;`.

## tsvector FTS

- `@db.index.fulltext 'search', 2` on two fields → one `tsvector_search` generated column + GIN index.
- `search(term, query, 'search')` runs `websearch_to_tsquery` and `ts_rank_cd` for ordering.

## Known limits

- `ensureTable()` creates schemas via `CREATE SCHEMA IF NOT EXISTS` when `@db.schema` / `@db.pg.schema` is set.
- `pgvector` extension must be enabled per database.
- `CITEXT` extension must be enabled per database.
