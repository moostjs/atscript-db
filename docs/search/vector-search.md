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

The threshold range is `0` to `1`, where `1` means exact match. This default can be overridden at query time via the `$threshold` control.

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

The `indexName` argument in `@db.search.filter` must match the name of a `@db.search.vector` index (the field name or explicit `indexName`). A field can be a pre-filter for multiple vector indexes.

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

Results are ordered by similarity (most similar first).

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

Additional filter conditions that are not declared as `@db.search.filter` apply **after** vector search as standard query filters:

```typescript
const results = await docs.vectorSearch(queryVector, {
  filter: {
    category: "tutorials", // pre-filter (declared with @db.search.filter)
    status: "published", // pre-filter (declared with @db.search.filter)
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

| Parameter    | Description                                                               |
| ------------ | ------------------------------------------------------------------------- |
| `$search`    | Text query (required — the controller converts it to an embedding)        |
| `$vector`    | Vector field name to search on (e.g., `embedding`)                        |
| `$threshold` | Minimum similarity score override (0–1); `0` disables threshold filtering |

When a table has only one vector field, `$vector=embedding` (the field name) is the minimal form. For multiple vector fields, `$vector` selects which one to search.

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

| Adapter        | Column type              | Index type            | Notes                                                                      |
| -------------- | ------------------------ | --------------------- | -------------------------------------------------------------------------- |
| **PostgreSQL** | `vector(N)` via pgvector | HNSW index            | Auto-provisions pgvector extension, distance operators `<->`, `<#>`, `<=>` |
| **MongoDB**    | Embedded array           | Atlas `$vectorSearch` | Requires Atlas M10+ cluster                                                |
| **MySQL**      | `VECTOR(N)`              | Native (9.0+)         | `VEC_DISTANCE_*` functions                                                 |
| **SQLite**     | JSON array               | None                  | Stores vectors as JSON — **no vector search support**                      |

::: warning
SQLite stores vector fields as JSON arrays but does **not** support vector search. Calling `vectorSearch()` on a SQLite adapter throws an error. If you need vector search, use PostgreSQL (pgvector), MongoDB (Atlas), or MySQL 9.0+.
:::

## Next Steps

- [Text Search](./) — full-text search with ranked results and field weighting
- [HTTP — Advanced](/http/advanced) — vector search URL parameters
- [Indexes & Constraints](/api/indexes) — other index types
