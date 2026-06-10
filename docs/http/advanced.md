---
outline: deep
---

# Relations & Search in URLs

This page covers the advanced URL query parameters for relation loading, text search, vector search, and aggregation. These work on top of the [basic query syntax](./query-syntax).

## Relation Loading ($with) {#with}

Load related data inline using `$with`. Relations must be declared with `@db.rel.to`, `@db.rel.from`, or `@db.rel.via` in your `.as` schema. See [Relations — Foreign Keys](/relations/) for how to define them.

### Basic Usage

Load a single relation:

```bash
curl "http://localhost:3000/todos/query?\$with=author"
```

**Response:**

```json
[
  {
    "id": 1,
    "title": "Buy milk",
    "authorId": 5,
    "author": { "id": 5, "name": "Alice" }
  }
]
```

### Multiple Relations

Comma-separate relation names:

```bash
curl "http://localhost:3000/todos/query?\$with=author,comments"
```

**Response:**

```json
[
  {
    "id": 1,
    "title": "Buy milk",
    "authorId": 5,
    "author": { "id": 5, "name": "Alice" },
    "comments": [{ "id": 10, "text": "Great task!", "todoId": 1 }]
  }
]
```

### With Controls

Apply sorting, limits, or projection to a loaded relation using parentheses:

```bash
curl "http://localhost:3000/todos/query?\$with=comments(\$limit=5&\$sort=-createdAt)"
```

**Response:**

```json
[
  {
    "id": 1,
    "title": "Buy milk",
    "comments": [
      { "id": 15, "text": "Latest comment", "createdAt": 1710000000 },
      { "id": 14, "text": "Earlier comment", "createdAt": 1709900000 }
    ]
  }
]
```

Inside parentheses, you can use any control parameter: `$sort`, `$limit`, `$skip`, `$select`.

### Nested Relations

Load relations of relations:

```bash
curl "http://localhost:3000/todos/query?\$with=comments(\$with=author)"
```

**Response:**

```json
[
  {
    "id": 1,
    "title": "Buy milk",
    "comments": [
      {
        "id": 10,
        "text": "Great task!",
        "author": { "id": 5, "name": "Alice" }
      }
    ]
  }
]
```

### Filtered Relations

Combine filters, controls, and nesting inside parentheses:

```bash
curl "http://localhost:3000/todos/query?\$with=comments(status=approved&\$sort=-createdAt&\$limit=3&\$with=author(\$select=name))"
```

All [filter operators](./query-syntax) and control parameters work inside relation sub-queries.

### Validation

The controller validates relation names against your schema:

- **Unknown relation** — returns `400` with a list of available relations
- **FK field used as relation** — `$with=projectId` returns `400` (use the navigation property name instead, e.g., `$with=project`)

::: tip FK fields auto-included
When using `$select` alongside `$with`, foreign key fields needed for joining are automatically included — even if not explicitly listed or explicitly excluded. This ensures relations resolve correctly.
:::

For the programmatic equivalent, see [Relations — Loading](/relations/loading).

## Text Search ($search, $index, $fuzzy) {#text-search}

Perform full-text search on fields annotated with `@db.index.fulltext` or similar search indexes.

### Basic Search

Search across all fulltext-indexed fields:

```bash
curl "http://localhost:3000/articles/query?\$search=mongodb+tutorial"
```

**Response:**

```json
[
  { "id": 3, "title": "MongoDB Tutorial for Beginners", "body": "..." },
  { "id": 7, "title": "Advanced MongoDB Patterns", "body": "..." }
]
```

### Named Search Index

Target a specific search index with `$index`:

```bash
curl "http://localhost:3000/products/query?\$search=wireless+headphones&\$index=product_search"
```

On MongoDB this is also how you pick a search **variant** — when the same field is indexed both ways (e.g. word match vs typeahead), `$index` selects which behavior runs. See [MongoDB → Search Variants](/adapters/mongodb#search-variants).

### Fuzzy Tolerance (MongoDB Atlas)

`$fuzzy` overrides the index's declared typo tolerance for a single request — `1` or `2` edits, or `0` to disable:

```bash
curl "http://localhost:3000/users/query?\$search=mngo&\$fuzzy=1"
```

The default comes from the index annotation (`@db.mongo.search.static`/`.dynamic`); see [MongoDB → Fuzzy Search](/adapters/mongodb#fuzzy-search).

### Combining with Filters

Search and filter can be used together:

```bash
curl "http://localhost:3000/articles/query?\$search=mongodb&status=published&\$sort=-createdAt"
```

### Paginated Search

Search works with both `/query` and `/pages`:

```bash
curl "http://localhost:3000/articles/pages?\$search=typescript&\$page=1&\$size=10"
```

::: info Adapter support
Full-text search support varies by adapter. MongoDB supports Atlas Search with named indexes. SQLite provides FTS5-based search. Check your [adapter's documentation](/adapters/) for details.
:::

For annotations and programmatic API, see [Text Search](/search/).

## Vector Search ($vector, $threshold, $search) {#vector-search}

Perform similarity search on fields annotated with `@db.search.vector`.

### How It Works

Vector search via URL requires three components:

1. **`$vector`** — the name of the vector field to search on
2. **`$search`** — the text query (converted to an embedding by the controller)
3. **`$threshold`** (optional) — minimum similarity threshold

The controller calls the `computeEmbedding()` hook to convert the search text into a vector, then passes it to the adapter's vector search.

### Basic Usage

```bash
curl "http://localhost:3000/articles/query?\$vector=embedding&\$search=machine+learning+basics"
```

**Response:**

```json
[
  { "id": 12, "title": "Introduction to ML", "score": 0.95 },
  { "id": 8, "title": "Deep Learning Guide", "score": 0.87 }
]
```

### With Threshold

Set a minimum similarity score:

```bash
curl "http://localhost:3000/articles/query?\$vector=embedding&\$search=machine+learning&\$threshold=0.8"
```

Only results with similarity >= 0.8 are returned.

### Combining with Filters

```bash
curl "http://localhost:3000/articles/query?\$vector=embedding&\$search=machine+learning&status=published&\$limit=10"
```

### The computeEmbedding Hook

Vector search via HTTP requires the `computeEmbedding()` hook to convert the search text into a vector. Without this override, vector search returns HTTP `501 Not Implemented`. See [Customization — computeEmbedding](./customization#computeembedding) for the full implementation guide.

For annotations and programmatic API, see [Vector Search](/search/vector-search).

## Geo Search ($center, $maxDistance, $minDistance) {#geo-search}

Tables with a [`@db.index.geo`](/search/geo-search) field expose a dedicated `GET /geo` endpoint for distance-ranked queries (MongoDB-only in v1):

```bash
curl "http://localhost:3000/listings/geo?\$center=-122.42,37.77&\$maxDistance=50000&status=ACTIVE"
curl "http://localhost:3000/listings/geo?\$center=-122.42,37.77&\$page=1&\$size=20"
```

`$center` (required) is `lng,lat`; `$maxDistance`/`$minDistance` are meters. Rows come back distance-ordered, each carrying `$distance` (meters); with `$page`/`$size` the response uses the `/pages` envelope. Standard filters, `$select`, and `$with` compose normally. See [Geo Search](/search/geo-search) for the annotation, the programmatic `geoSearch()` API, the `$geoWithin` filter operator, and per-adapter support.

## Aggregation ($groupBy) {#groupby}

Group records and compute aggregate values using `$groupBy`.

### Basic Usage

Group by a field and select aggregate functions:

```bash
curl "http://localhost:3000/orders/query?\$groupBy=status&\$select=status,count(*):total"
```

**Response:**

```json
[
  { "status": "pending", "total": 12 },
  { "status": "shipped", "total": 45 },
  { "status": "delivered", "total": 128 }
]
```

Aggregate functions in `$select` use the syntax `fn(field):alias`.

### With Filters

Apply filters before aggregation:

```bash
curl "http://localhost:3000/orders/query?createdAt>1700000000&\$groupBy=region&\$select=region,sum(amount):total,count(*):orders"
```

**Response:**

```json
[
  { "region": "US", "total": 15420.5, "orders": 87 },
  { "region": "EU", "total": 8930.0, "orders": 42 }
]
```

### With Sorting

Sort aggregated results:

```bash
curl "http://localhost:3000/orders/query?\$groupBy=status&\$select=status,sum(amount):total&\$sort=-total&\$limit=5"
```

### Aggregate Functions

The standard SQL aggregate functions are available: `count(*)`, `sum(field)`, `avg(field)`, `min(field)`, `max(field)`. See [Aggregation Annotations](/views/aggregations) for the full reference.

### Limitations

::: warning Restrictions

- **Cannot combine with `$with`** — using `$groupBy` and `$with` together returns `400`
- Plain fields in `$select` must also appear in `$groupBy`
  :::

## Nested Writes via HTTP {#nested-writes}

`POST`, `PUT`, and `PATCH` request bodies can contain nested relation data. The controller processes nested objects through the [deep operations](/relations/deep-operations) pipeline.

**Example — insert a project with tasks:**

```bash
curl -X POST http://localhost:3000/projects/ \
  -H "Content-Type: application/json" \
  -d '{
    "title": "New Project",
    "tasks": [
      { "title": "Task 1", "status": "todo" },
      { "title": "Task 2", "status": "todo" }
    ]
  }'
```

The controller inserts the project first, then creates the related tasks with the correct foreign key values.

For full details on how nested data is processed across foreign keys, see [Relations — Deep Operations](/relations/deep-operations).

## Next Steps

- [Customization](./customization) — Hooks for search, access control, and extending controllers
- [Relations — Loading](/relations/loading) — Programmatic relation loading
- [Text Search](/search/) — Search annotations and programmatic API
- [Vector Search](/search/vector-search) — Vector search annotations and programmatic API
