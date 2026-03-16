---
outline: deep
---

# Text Search

<!--@include: ../_experimental-warning.md-->

Full-text search lets you search across one or more string fields with ranked results and optional field weighting. Define your search indexes in the `.as` schema, then query with a simple API — the adapter handles the engine-specific implementation.

## Defining a Fulltext Index

Fulltext search indexes are defined with `@db.index.fulltext` in your `.as` schema. See [Indexes & Constraints — Full-Text Search Index](/api/indexes#full-text-search-index) for the annotation syntax, composite indexes, and field weighting.

Here's a quick example:

```atscript
@db.table 'articles'
export interface Article {
    @meta.id
    id: number

    @db.index.fulltext "content_idx", 3
    title: string

    @db.index.fulltext "content_idx"
    body: string
}
```

Fields sharing the same index name form a **composite** full-text index. The optional weight argument controls relevance ranking — here, matches in `title` score 3× higher.

## Programmatic API

### Checking Capabilities

```typescript
const articles = db.getTable(Article);

// Does this table have fulltext indexes?
articles.isSearchable(); // true

// List all search indexes
articles.getSearchIndexes();
// [{ name: 'content_idx', description: '...', type: 'text' }]
```

### Basic Search

```typescript
const results = await articles.search("typescript tutorial", {
  filter: {},
  controls: { $limit: 20 },
});
```

The `search()` method returns records ranked by relevance.

### Search with Count

For paginated search results:

```typescript
const result = await articles.searchWithCount("typescript tutorial", {
  filter: {},
  controls: { $skip: 20, $limit: 10 },
});

console.log(result.data); // matching articles
console.log(result.count); // total matches
```

### Targeting a Specific Index

When a table has multiple fulltext indexes, pass the index name:

```typescript
const results = await articles.search(
  "tutorial",
  {
    filter: {},
    controls: {},
  },
  "content_idx",
);
```

If omitted, the first available fulltext index is used.

## Combining Search with Filters

Search results can be further filtered by regular query conditions:

```typescript
const results = await articles.search("typescript", {
  filter: { status: "published", category: "tutorials" },
  controls: { $limit: 10 },
});
```

The text search narrows by relevance, then the filter conditions narrow further. Sorting, pagination, and field selection all work as usual.

## HTTP Access

Text search is available via HTTP using the `$search` URL parameter on the `/query` or `/pages` endpoints:

```
GET /articles/query?$search=typescript%20tutorial
GET /articles/query?$search=typescript%20tutorial&$index=content_idx
GET /articles/query?$search=database&category=tech
GET /articles/pages?$search=typescript&$page=1&$size=20
```

The `$search` parameter provides the search text. Add `$index` to target a specific fulltext index when multiple exist. Regular filter parameters (like `category=tech`) combine with search results using AND logic.

See [HTTP — Advanced](/http/advanced) for the full URL query syntax.

## Adapter Implementations

Each adapter maps `@db.index.fulltext` to its native full-text search engine:

| Adapter        | Index type                                              | Search mechanism                       | Weighted?           |
| -------------- | ------------------------------------------------------- | -------------------------------------- | ------------------- |
| **PostgreSQL** | GIN index on `to_tsvector()`                            | `plainto_tsquery()`                    | Yes — `setweight()` |
| **MongoDB**    | Text index (all deployments), Atlas Search (Atlas only) | `$text` / `$search`                    | Yes — field weights |
| **SQLite**     | FTS5 virtual table                                      | `MATCH`                                | No                  |
| **MySQL**      | `FULLTEXT` index                                        | `MATCH ... AGAINST` (natural language) | No                  |

::: info
All adapters expose the same `search()` and `searchWithCount()` API — engine differences are handled internally. See individual adapter pages for engine-specific details and configuration options.
:::

## Next Steps

- [Vector Search](./vector-search) — similarity search with embedding vectors
- [Indexes & Constraints](/api/indexes) — other index types (plain, unique)
- [HTTP — Advanced](/http/advanced) — search and vector search URL parameters
