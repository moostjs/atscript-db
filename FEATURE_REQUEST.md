# Feature request: Contentless FTS5 on SQLite

## Summary

Add first-class support in atscript-db for **contentless FTS5** indexes on the SQLite adapter. The current `@db.index.fulltext` annotation maps onto a content-bearing FTS5 column, which forces the indexed text to be persisted twice (once on the table row, once inside FTS5's shadow tables). For workloads where the source of truth lives outside the database (e.g. markdown files on disk), this is wasteful and conceptually wrong: the database should index the content without owning a copy of it.

## Motivation — concrete use case (kb-cli)

[kb-cli](https://github.com/mav-rik/kb-cli) is a markdown wiki where `.md` files on disk are the source of truth and SQLite is a rebuildable index. Documents are being split into heading-based **chunks** (one row per section) for hybrid (FTS5 + vector) search. The chunk rows must carry only pointers/metadata (id, doc id, heading path, line range, content hash, embedding) — never the raw text, because the text already exists on disk and any duplicate would invite drift.

Today, to get FTS5 keyword search on chunks we have to:

1. Hand-roll a side service that opens its own `better-sqlite3` handle to the same `index.db`.
2. Manage a raw SQL `CREATE VIRTUAL TABLE chunks_fts USING fts5(..., content='', contentless_delete=1)`.
3. Manually keep it in sync with the atscript-managed `chunks` table on every insert/update/delete.
4. Handle drift between the atscript table and the FTS table in our own lint/reindex tooling.

This is a real, in-flight pattern: see [src/services/fts.service.ts](https://github.com/mav-rik/kb-cli/blob/main/src/services/fts.service.ts) (the existing doc-level FTS service) — soon to be duplicated for chunks. Both side services would disappear if atscript-db owned contentless FTS5 natively.

## What's available in SQLite

SQLite ≥ 3.43 (2023-08) supports contentless FTS5 with deletion:

```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  id UNINDEXED,
  doc_id UNINDEXED,
  heading_path,
  heading,
  title,
  tags,
  content,
  content='',          -- contentless: no source text stored
  contentless_delete=1, -- standard DELETE WHERE works
  tokenize='porter unicode61'
)
```

The bundled SQLite that ships with `better-sqlite3` is well past that version (verified 3.53 in the kb-cli repo). So contentless + delete-capable is universally available for our SQLite adapter today.

The only nuance is that FTS5 keeps token tombstones for deleted rows when `content=''` is set; a periodic `INSERT INTO ft(ft) VALUES('optimize')` reclaims space. This is a maintenance task atscript-db could expose, but isn't blocking.

## Why the existing `@db.index.fulltext` doesn't fit

The current annotation models "FTS5 mirrors a column on this row" — it presupposes the indexed text exists on the table. Contentless FTS5 inverts that: the text is supplied at insert time and discarded after tokenization. Three structural differences:

1. **Indexed fields don't live on the row.** For a chunk, the fields we want indexed (`heading`, `heading_path`, `title`, `tags`, `content`) are partially **transient** (`content` exists only in the source file) and partially **denormalized from a parent row** (`title`, `tags` belong to the parent document, not the chunk).
2. **FTS input must be passed alongside the row at insert time.** Not derived from the row.
3. **There is no `snippet()` to call back** — contentless FTS5 cannot return source text. Callers must already know how to reconstruct the snippet themselves (in kb-cli's case, by reading the file using the stored `from_line`/`to_line` columns).

A single new annotation extending the existing FTS surface won't work cleanly. A small new shape is needed.

## Proposed API

### 1. Table-level annotation

```as
@db.table 'chunks'
@db.fts.contentless 'chunks_fts'
@db.depth.limit 0
export interface Chunk {
  @meta.id
  id: string

  docId: string

  heading?: string
  headingPath?: string
  headingLevel?: number
  fromLine: number
  toLine: number
  position: number
  contentHash: string

  @db.search.vector 768, 'cosine'
  embedding?: number[]
}
```

`@db.fts.contentless 'chunks_fts'` declares a contentless FTS5 sidecar table associated with this row's lifecycle. The persisted columns are untouched.

### 2. Companion "FTS input" shape

```as
@db.fts.input.for Chunk
export interface ChunkFtsInput {
  @db.fts.weight 3
  headingPath?: string

  @db.fts.weight 3
  heading?: string

  @db.fts.weight 2
  title: string

  @db.fts.weight 1
  tags: string

  @db.fts.weight 1
  content: string
}
```

`@db.fts.input.for <TargetInterface>` binds an input shape to a target table. Field annotations set BM25 weights. The shape's fields define the FTS5 virtual table's indexed columns in declaration order; weights become the `bm25()` vector at search time. Optional fields are tolerated (passed as empty strings to FTS5).

The shape's fields are _not persisted to the chunks row_ — atscript-db only uses them to feed the FTS5 virtual table.

### 3. Generated runtime API

When the model is compiled, atscript-db should expose:

```ts
const chunks = space.getTable(Chunk);

// Insert + index in one logical operation.
await chunks.insertOne(chunkRow, { fts: chunkFtsInput });

// Update existing row + reindex its FTS row.
await chunks.updateOne(chunkRow, { fts: chunkFtsInput });

// Update the FTS row only (e.g. parent doc's title/tags changed but chunk row didn't).
await chunks.reindexFts(id, chunkFtsInput);

// Delete row + FTS row in one call.
await chunks.deleteOne(id);
// (or auto-cascade — FTS row is removed when the underlying row is)

// Search → returns ids ranked by BM25, no row content.
const hits = await chunks.searchFts(query, { limit: 20 });
// hits: { id: string; rank: number }[]
```

Filtering at the SQL level should accept the UNINDEXED columns:

```ts
// Optional second-pass filter (useful for "fts within docId").
await chunks.searchFts(query, { limit: 20, where: { docId } });
```

Implementation note: `searchFts` should swallow malformed FTS5 expressions and return `[]`, matching what most clients want for natural-language queries.

### 4. Schema sync behavior

`syncSchema` should:

- Create the `chunks_fts` virtual table with the right columns (`id UNINDEXED, <fts-input-fields-in-order>`) and `content='', contentless_delete=1` if SQLite ≥ 3.43, or raise a clear error/fallback on older SQLite.
- Add an `id UNINDEXED` column automatically — it's the join key, always.
- Add a `doc_id UNINDEXED` (or any other named filter target) only if a field carries an opt-in annotation, e.g. `@db.fts.filter` on `docId` in the input shape — keeps the API small but extensible.

If the FTS table already exists with a different column set, atscript-db should refuse to sync silently and surface a clear error so the host app can decide to drop+rebuild (analogous to how vec0 shadows behave today on dim mismatch).

### 5. Reindex / drift handling

Two utility methods on the table:

```ts
await chunks.dropFts(); // drop and recreate the virtual table — for full reindex
await chunks.optimizeFts(); // reclaim space after many deletes (rebuild segments)
```

`dropFts` is what `kb reindex` needs today; `optimizeFts` is a periodic maintenance hook for long-lived wikis.

### 6. Other adapters

The annotation should be **SQLite-only initially**. On a non-SQLite adapter, `syncSchema` should either:

- Throw a clear "contentless FTS5 is only supported on SQLite" error, or
- Silently fall back to a content-bearing equivalent if the adapter supports one (e.g. Postgres tsvector with a stored-but-not-projected column).

I'd prefer (a) — explicit failure — until a second adapter actually implements it. Silent fallback hides design intent.

## Why this matters beyond kb-cli

This shape isn't kb-specific. Any project where:

- The canonical text lives outside the database (files on disk, blob storage, an external CMS), or
- The text is reconstructable from other columns (e.g. computed concatenations), or
- The text is too large to want stored twice (long-form docs, transcripts)

…will hit the same wall today. Forcing them to hand-roll a side service replicates `documents_fts` patterns across every project. Solving it once in atscript-db generalizes neatly.

## What I'd accept as a minimum viable shape

If the full annotation surface is too much for v1, the smallest thing that would let kb-cli drop its raw-SQL FTS services entirely is:

1. `@db.fts.contentless 'name'` on the table.
2. A companion input-shape annotation `@db.fts.input.for Target` with per-field weights.
3. `table.insertOne({...}, { fts: {...} })`, `table.deleteOne(id)` (auto-cascade), and `table.searchFts(query, { limit })`.
4. SQLite ≥ 3.43 hard requirement; older → throw.

Everything else (the dedicated `reindexFts`, `optimizeFts`, custom UNINDEXED filter columns) can come in a follow-up — those are nice-to-haves, not blockers.

## Migration note for existing `@db.index.fulltext` users

This proposal does not change the existing `@db.index.fulltext` annotation — it stays as the content-bearing path. The new `@db.fts.contentless` is purely additive. Existing models keep working unchanged.

## Reference

Live use case + side-service we'd replace: [kb-cli `src/services/fts.service.ts`](https://github.com/mav-rik/kb-cli/blob/main/src/services/fts.service.ts) and the in-flight `chunk-fts.service.ts` mirror. The latter currently has to be written by hand specifically because atscript-db can't model what we need.
