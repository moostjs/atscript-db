---
outline: deep
---

# Vector Search

<!--@include: ../_experimental-warning.md-->

Vector search enables similarity retrieval using embedding vectors — useful for AI-powered search, recommendations, and RAG applications. Define vector fields and indexes in your `.as` schema, generate embeddings externally, then search with a simple API.

## Defining a Vector Field

Use `@db.search.vector` on a field to mark it as a vector embedding:

```atscript
@db.table 'documents'
export interface Document {
    @meta.id
    id: number

    title: string

    @db.search.vector 1536, "cosine"
    embedding: db.vector
}
```

The annotation takes up to three arguments:

| Argument     | Type   | Required | Description                                                                                           |
| ------------ | ------ | -------- | ----------------------------------------------------------------------------------------------------- |
| `dimensions` | number | Yes      | Vector size — must match your embedding model output (e.g., 1536 for OpenAI `text-embedding-3-small`) |
| `similarity` | string | No       | Distance metric: `"cosine"` (default), `"euclidean"`, or `"dotProduct"`                               |
| `indexName`  | string | No       | Index name — defaults to the field name                                                               |

::: tip Dimensions
`dimensions` is any positive integer — the size of your embedding model's output. Anything else (`0`, `-1`, `1.5`) is rejected at compile time. Editor completion offers the common sizes `256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 16384`; before 0.1.168 only these were accepted. Common choices: 384 (Sentence-Transformers MiniLM), 768 (BERT, Cohere `embed-multilingual-v3.0`), 1024 (Cohere `embed-english-v3.0`), 1536 (OpenAI `text-embedding-3-small`, `text-embedding-ada-002`), 3072 (OpenAI `text-embedding-3-large`).
:::

The field type can be `db.vector` (a semantic alias for `number[]`) or `number[]` directly.

::: tip
Use `db.vector` as the field type to make the intent clearer — it compiles to `number[]` but signals that this field holds an embedding vector.
:::

## Setting a Default Threshold

Use `@db.search.vector.threshold` to set a minimum similarity score. Results below this threshold are excluded from search results:

```atscript
@db.search.vector 1536, "cosine"
@db.search.vector.threshold 0.7
embedding: db.vector
```

The threshold is a minimum [`$score`](#result-fields), from `0` to `1`, where `1` means exact match. It means the same on every adapter and for every metric: a row is returned only when its `$score` reaches the threshold (up to floating-point rounding). For `euclidean` that is `distance <= 1 / threshold − 1` (`0.5` keeps rows within distance `1`), and for `dotProduct` it is `dot product >= 2 × threshold − 1`. Before 0.1.183 SQLite, PostgreSQL and MySQL read a `euclidean` threshold differently, and PostgreSQL a `dotProduct` one (see [Upgrading](/guide/upgrading#v0-1-183)). This default can be overridden at query time via the `$threshold` control, which must be a finite number (`INVALID_QUERY` otherwise).

## Pre-Filtering

Use `@db.search.filter` to mark fields as pre-filters for vector search. Pre-filters narrow the candidate set **before** similarity computation, improving both performance and relevance:

```atscript
@db.table 'documents'
export interface Document {
    @meta.id
    id: number

    title: string

    @db.search.vector 1536, "cosine"
    @db.search.vector.threshold 0.7
    embedding: db.vector

    @db.search.filter "embedding"
    category: string

    @db.search.filter "embedding"
    status: string
}
```

The `indexName` argument in `@db.search.filter` must match the name of a `@db.search.vector` index (the field name or explicit `indexName`). A field can be a pre-filter for multiple vector indexes, and an index can have several pre-filter fields.

On MongoDB (since 0.1.151), the top-level conditions of the query filter on pre-filter fields move into the `$vectorSearch` stage's `filter`, so the nearest neighbours are taken among the matching documents and a page comes back full. A condition moves when it compares a string, number, boolean, `Date` or ObjectId with `$eq` (or a bare value), `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in` or `$nin` (a non-empty list of such values). Every other condition — on other fields, against `null`, `$regex`, `$exists`, `$or`, relational predicates — filters the top-k results afterwards, so such a query can return fewer rows than `$limit`. `$skip` is part of the top-k: `{ $skip: 20, $limit: 10 }` asks `$vectorSearch` for 30 results and returns the last 10.

## Programmatic API

### Checking Capabilities

```typescript
const docs = db.getTable(Document);

docs.isVectorSearchable(); // true
docs.getSearchIndexes();
// [{ name: 'embedding', description: '...', type: 'vector' }]
```

### Basic Vector Search

Pass a pre-computed embedding vector to find similar records:

```typescript
// Generate embedding externally (OpenAI, Cohere, etc.)
const queryVector = await generateEmbedding("search query text");

const results = await docs.vectorSearch(queryVector, {
  filter: {},
  controls: { $limit: 20 },
});
```

Each row carries `$score`, higher = closer (see [Result Fields](#result-fields)). A row whose vector field holds no vector is never returned. Results are ordered by similarity (most similar first): the nearest rows are the result, so there is no unranked vector search, and `controls.$rank: false` — the [unranked text search](/search/#unranked) control — is rejected with `INVALID_QUERY` (since 0.1.175). A `controls.$sort` reorders the rows on MongoDB; SQLite, PostgreSQL and MySQL ignore it and keep the similarity order. `controls.$select` projects the rows exactly like `findMany()` — inclusion and exclusion forms, on every adapter (the SQL adapters returned every column before 0.1.143, so `@db.writeOnly` fields leaked through `$vector` queries over HTTP).

### Vector Search with Count

For paginated results:

```typescript
const result = await docs.vectorSearchWithCount(queryVector, {
  filter: {},
  controls: { $limit: 10 },
});

console.log(result.data); // similar documents
console.log(result.count); // total matches above threshold
```

### Result Fields {#result-fields}

Every row comes back with `$score` (since 0.1.183): how close the row is to the query vector, higher = closer. It is MongoDB Atlas's `vectorSearchScore` scale, the scale of the threshold, on every adapter that has vector search:

| Metric       | `$score`                                             | Range                                                      |
| ------------ | ---------------------------------------------------- | ---------------------------------------------------------- |
| `cosine`     | `(1 + cosine similarity) / 2`                        | `1` (same direction) to `0` (opposite)                     |
| `euclidean`  | `1 / (1 + distance)`, for the straight-line distance | `1` (same point), falling toward `0` as the distance grows |
| `dotProduct` | `(1 + dot product) / 2`                              | `0` to `1` for normalized vectors                          |

Use normalized (unit-length) vectors with `dotProduct`; with other vectors the score can leave `0`–`1`. SQLite runs `dotProduct` as cosine, so a `dotProduct` index there gets the cosine `$score` (the same value for normalized vectors).

```typescript
const rows = await docs.vectorSearch(queryVector, {
  filter: {},
  controls: { $threshold: 0.8, $select: ["title"] },
});
// [{ title: "Intro to ML", $score: 0.93, ... }, { title: "Deep Learning", $score: 0.85, ... }]
```

- **Threshold:** a row is returned only when its `$score` reaches the threshold (`$threshold`, else `@db.search.vector.threshold`), up to floating-point rounding. Without a `$sort`, rows come closest first, so `$score` falls along the result.
- **`$select`:** `$score` is returned whatever the `$select`, in its inclusion and exclusion forms. It is not a field you can name: `$select: ["title", "$score"]` fails with `Unknown field "$score"`.
- **Everywhere:** the rows of `vectorSearchWithCount()` carry it, and so do the rows of `$vector` requests over HTTP (`/query` and `/pages`). `vectorSearch()` and `vectorSearchWithCount()` type their rows `& { $score: number }`, and the [browser client](/http/client) types it on `query()` / `pages()` rows of a query with `$search` and `$vector`.
- **MySQL:** vector search does not run on current MySQL or MariaDB servers; see [MySQL vector support](/adapters/mysql#vector-support-mysql-9-0).

`$score` is the only field a vector search adds to a row. Before 0.1.184 rows also carried an engine-specific field — `_distance` on SQLite, PostgreSQL and MySQL, `_score` on MongoDB when a threshold applied. [Upgrading](/guide/upgrading#v0-1-184) shows how to compute those values from `$score`. A stored field of yours named `_distance` or `_score` is now an ordinary field.

The in-memory adapter has no vector search.

DOs and DON'Ts:

- **Do cut far rows with `$threshold`**, not by filtering rows on `$score` yourself: the threshold applies before the page is cut, so pages and counts stay right.
- **Do use normalized vectors with `dotProduct`.** With other vectors the score can leave `0`–`1`, and one threshold means a different closeness for vectors of different lengths.

### Overriding Threshold at Query Time

Use the `$threshold` control to override the schema-level default:

```typescript
const results = await docs.vectorSearch(queryVector, {
  filter: {},
  controls: { $threshold: 0.9, $limit: 10 }, // stricter than default
});
```

### Targeting a Specific Index

When a table has multiple vector fields, pass the index name as the first argument:

```typescript
const results = await docs.vectorSearch("contentEmbedding", queryVector, {
  filter: {},
  controls: { $limit: 10 },
});
```

## Combining with Filters

### Pre-filters

Fields marked with `@db.search.filter` narrow candidates **before** similarity computation. Pass them in the query filter:

```typescript
const results = await docs.vectorSearch(queryVector, {
  filter: { category: "tutorials" },
  controls: { $limit: 10 },
});
```

### Post-filters

Additional filter conditions that are not declared as `@db.search.filter` (or that a pre-filter cannot express — see [Pre-Filtering](#pre-filtering)) apply **after** vector search as standard query filters, to the top-k results — they can shorten the page:

```typescript
const results = await docs.vectorSearch(queryVector, {
  filter: {
    category: "tutorials", // pre-filter (declared with @db.search.filter)
    title: { $regex: "^Intro" }, // post-filter (title is not a pre-filter field)
  },
  controls: { $limit: 10 },
});
```

::: info
Pre-filtering is more efficient than post-filtering because it reduces the candidate set before computing distances. Mark frequently-filtered fields with `@db.search.filter` for best performance.
:::

## Multiple Vector Fields

Use `indexName` to distinguish multiple embedding fields on the same record:

```atscript
@db.table 'documents'
export interface Document {
    @meta.id
    id: number

    title: string
    body: string

    @db.search.vector 1536, "cosine", "content"
    contentEmbedding: db.vector

    @db.search.vector 384, "cosine", "title"
    titleEmbedding: db.vector

    @db.search.filter "content"
    @db.search.filter "title"
    category: string
}
```

Target each index by name:

```typescript
// Search by content similarity
const byContent = await docs.vectorSearch("content", contentVector);

// Search by title similarity
const byTitle = await docs.vectorSearch("title", titleVector);
```

## HTTP Access

Vector search over HTTP uses `$search` (the text query) combined with `$vector` (the vector field name). The controller converts the text to an embedding internally via `computeEmbedding()`:

```
GET /documents/query?$search=machine+learning&$vector=embedding
GET /documents/query?$search=machine+learning&$vector=embedding&$threshold=0.8
GET /documents/query?$search=cooking&$vector=embedding&category=food&$limit=10
GET /documents/pages?$search=optimization&$vector=embedding&$page=1&$size=20
```

| Parameter    | Description                                                        |
| ------------ | ------------------------------------------------------------------ |
| `$search`    | Text query (required — the controller converts it to an embedding) |
| `$vector`    | Vector field name to search on (e.g., `embedding`)                 |
| `$threshold` | Minimum [`$score`](#result-fields) override (0–1)                  |

When a table has only one vector field, `$vector=embedding` (the field name) is the minimal form. For multiple vector fields, `$vector` selects which one to search. Each row of the response carries [`$score`](#result-fields).

::: warning
Your controller must override `computeEmbedding()` to convert the `$search` text into a vector. Without this override, vector search via HTTP returns `501 Not Implemented`. See [HTTP — Advanced](/http/advanced) for setup details.
:::

## Similarity Metrics

| Metric          | Description                                   | Best for                                          |
| --------------- | --------------------------------------------- | ------------------------------------------------- |
| **Cosine**      | Angle between vectors (normalized, range 0–1) | Text embeddings, most common choice               |
| **Euclidean**   | Straight-line distance (lower = more similar) | Spatial data, image features                      |
| **Dot product** | Inner product (requires normalized vectors)   | Recommendation systems, pre-normalized embeddings |

::: tip
Cosine similarity is the default and works well for most text embedding models (OpenAI, Cohere, etc.). Only change the metric if your embedding model specifically recommends a different one.
:::

## Adapter Support

| Adapter        | Column type                                                                       | Index type            | Notes                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **PostgreSQL** | `vector(N)` via pgvector                                                          | HNSW index            | Auto-provisions pgvector extension; distance operators `<->`, `<#>`, `<=>`                                                                                               |
| **MongoDB**    | Embedded array                                                                    | Atlas `$vectorSearch` | Requires Atlas M10+ cluster                                                                                                                                              |
| **MySQL**      | `VECTOR(N)` on MySQL 9 and later and on MariaDB; `JSON` on MySQL 8                | None                  | **Vector search does not run** on current MySQL or MariaDB servers — see [MySQL vector support](/adapters/mysql#vector-support-mysql-9-0)                                |
| **SQLite**     | Float32 `BLOB` when `sqlite-vec` is loaded (since 0.1.178); JSON `TEXT` otherwise | `vec0` virtual table  | Requires the `sqlite-vec` extension; falls back to JSON storage without it. Older rows and read-back precision: [SQLite vector storage](/adapters/sqlite#vector-storage) |

::: warning SQLite vector search requires `sqlite-vec`
SQLite supports vector search only when the [`sqlite-vec`](https://github.com/asg017/sqlite-vec) extension is loaded. Construct the driver with `new BetterSqlite3Driver(path, { vector: true })` and ensure the extension is installed.

Without `sqlite-vec`, vectors are stored as JSON text and `vectorSearch()` throws — schema sync, inserts, and reads still work, but similarity queries are unavailable.
:::

## Next Steps

- [Text Search](./) — full-text search with ranked results and field weighting
- [Geo Search](./geo-search) — distance-ranked search over coordinates (same API shape)
- [HTTP — Advanced](/http/advanced) — vector search URL parameters
- [Indexes & Constraints](/api/indexes) — other index types
