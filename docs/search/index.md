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

### Integer fields: exact-number match

A fulltext index may also list an **integer** field (`number.int` and its sizes, a `number` with `@expect.int`, or a `@db.default.increment` key). Integers are never part of the engine's text index — they are matched **by exact number**, OR'd with the text match, when the whole search term is a whole number:

```atscript
@db.table 'tickets'
export interface Ticket {
    @meta.id
    @db.index.fulltext "ticket_idx"   // the primary key is index-backed
    id: number.int

    @db.index.fulltext "ticket_idx"
    title: string

    @db.index.fulltext "ticket_idx"
    @db.index.unique                  // the first field of a plain/unique index
    refNo: number.int
}
```

`search("2946")` returns rows whose `title` contains the word `2946`, plus the row whose `id` or `refNo` **equals** `2946`. It does **not** return `29461277` — a native index matches whole numbers only; for substring matching on numbers use [`@db.column.searchable`](/http/advanced#search-fallback) on the integer field (no native index).

| Term                                       | Numeric branch? | Notes                                         |
| ------------------------------------------ | --------------- | --------------------------------------------- |
| `2946` (surrounding spaces are trimmed)    | yes             | surrounding blanks are trimmed                |
| `-12`                                      | yes             | negative numbers are exact matches too        |
| `02946`, `+5`, `-0`, `1.5`, `1e3`, `12 34` | no              | not a plain integer literal (text match only) |
| `9007199254740993`                         | no              | beyond the safe-integer range                 |
| `invoice 2946`                             | no              | only the **whole** term counts                |

Rules:

- The integer member must be **index-backed**, so the equality does not scan: the primary key (the first `@meta.id`), `_id`, or the first field of a `@db.index.plain` / `@db.index.unique`. A schema that breaks this is a compile error in the editor and a throw when the table metadata is built.
- Integer members belong to **one index each**: a search ORs only the integer members of the index it searches (on every adapter, MongoDB included). A search naming no index uses the first `@db.index.fulltext` that has at least one **text** member (the first index when none has), so an integer-only index declared first is not the default; name it with `$index` to search it alone.
- `@db.writeOnly` cannot be combined with `@db.index.fulltext` or `@db.column.searchable` (compile error; a search hit would reveal the sealed value).
- Floats (`number`, `number.double`), decimals, timestamps and `@db.column.precision` fields are refused with a diagnostic — filter those by range instead.
- A `weight` on an integer member is ignored (the editor warns).
- An index of **integer members only** needs no engine artifact (no DDL) but still exists: it is listed by `getSearchIndexes()`, makes the table natively searchable, and a term that is not a whole number matches nothing. Because the table is then natively searchable, `@db.column.searchable` fields are no longer consulted (native search wins).
- Ordering of a mixed text + number result is adapter-defined (MongoDB ranks text hits first); pass `$sort` for a stable order.
- Every entry point — `search()`, `searchWithCount()`, `/query`, `/pages`, `$count`, grouped `$search` aggregates, query targets and `resolveQuery` — applies the same predicate, so counts and rows agree.

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

`isSearchable()` counts **text** indexes only. `getSearchIndexes()` also lists vector indexes (`type: 'vector'`) so index pickers can offer them, but a vector index answers `vectorSearch()` and nothing else: a table whose only search declaration is `@db.search.vector` reports `isSearchable() === false` and rejects `search()` with `DbError("INVALID_QUERY", [{ path: "$search" }])`. Vector capability has its own probe — `isVectorSearchable()`.

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

| Adapter        | Index type                                    | Search mechanism                       | Per-field weights?                               | Integer members                                             |
| -------------- | --------------------------------------------- | -------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| **PostgreSQL** | GIN index on `to_tsvector('english', ...)`    | `plainto_tsquery()`                    | No — weights in `@db.index.fulltext` are ignored | `OR "col" = CAST(? AS BIGINT)`                              |
| **MongoDB**    | Classic text index (works on all deployments) | `$text`                                | Yes — field weights                              | `$or` of `$text` and `{ col: { $eq: n, $type: "number" } }` |
| **SQLite**     | FTS5 virtual table                            | `MATCH`                                | No                                               | `OR "col" = ?` next to the FTS5 `rowid` lookup              |
| **MySQL**      | `FULLTEXT` index                              | `MATCH ... AGAINST` (natural language) | No                                               | primary-key set of a `UNION` of the `MATCH` and `= n` arms  |

::: info
All adapters expose the same `search()` and `searchWithCount()` API — engine differences are handled internally. See individual adapter pages for engine-specific details and configuration options.
:::

MongoDB Atlas goes beyond word matching with **autocomplete/typeahead**, query-time **fuzzy** tolerance, and a per-index **match strategy** — declared with the `@db.mongo.search.*` annotations (separate from `@db.index.fulltext`, Atlas-only, queried via `$search`). See [MongoDB → Atlas Search](/adapters/mongodb#atlas-search).

### Term syntax per engine

The `$search` text is passed to the engine, so each engine's own operator syntax applies:

- **SQLite (FTS5)** — the term is quoted before it reaches `MATCH`, so no input can raise an FTS5 syntax error (`-2946`, `a AND`, `title:x`, `(` are plain text). Words are AND-ed; a `"quoted phrase"` stays a phrase; a trailing `*` on a word is a prefix match (`quok*`). `AND` / `OR` / `NOT` / `NEAR` and column filters are **not** operators — they are searched as words.
- **MongoDB (`$text`)** — operators apply natively: `-word` excludes a word, `"a phrase"` matches the phrase, and a plain list of words matches **any** of them (OR). A term made only of a negation (`-word`) matches nothing by itself; the integer equality branch is unaffected.
- **PostgreSQL** — `plainto_tsquery`: words are AND-ed, punctuation is ignored.
- **MySQL** — natural-language mode: relevance-ranked, words OR-ed, short and stop words ignored.

## Next Steps

- [Vector Search](./vector-search) — similarity search with embedding vectors
- [Geo Search](./geo-search) — distance-ranked search over coordinates
- [Indexes & Constraints](/api/indexes) — other index types (plain, unique)
- [HTTP — Advanced](/http/advanced) — search and vector search URL parameters
