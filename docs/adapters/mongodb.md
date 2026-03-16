---
outline: deep
---

# MongoDB

<!--@include: ../_experimental-warning.md-->

The MongoDB adapter (`@atscript/db-mongo`) connects your `.as` models to MongoDB with native nested object storage, aggregation pipelines, Atlas Search, and vector search. It translates annotation-driven CRUD operations into native MongoDB queries while preserving the same `AtscriptDbTable` API used by all adapters.

## Installation

```bash
pnpm add @atscript/db-mongo mongodb
```

Register the MongoDB plugin in your `atscript.config.mts` to enable `@db.mongo.*` annotations and `mongo.*` primitives:

```typescript
import { defineConfig } from "@atscript/core";
import ts from "@atscript/typescript";
import { dbPlugin } from "@atscript/db/plugin";
import mongo from "@atscript/db-mongo/plugin";

export default defineConfig({
  plugins: [ts(), dbPlugin(), mongo()],
});
```

`dbPlugin()` is **required** — it registers all portable `@db.*` annotations. See [Setup](/guide/setup) for full configuration details.

## Setup

Create a `DbSpace` with a `MongoAdapter` factory:

```typescript
import { DbSpace } from "@atscript/db";
import { MongoAdapter } from "@atscript/db-mongo";
import { MongoClient } from "mongodb";

const client = new MongoClient("mongodb://localhost:27017");
const mongoDb = client.db("myapp");
const db = new DbSpace(() => new MongoAdapter(mongoDb, client));
```

The second constructor argument (`client`) enables transaction support. If you do not need transactions, `new MongoAdapter(mongoDb)` without the client is sufficient.

Or use the convenience helper:

```typescript
import { createAdapter } from "@atscript/db-mongo";

const db = createAdapter("mongodb://localhost:27017/myapp");
```

`createAdapter` creates a `MongoClient` (connection is lazy — established on first query), extracts the database from the connection string, and returns a ready-to-use `DbSpace`.

Once you have a `DbSpace`, get a table handle for any `.as` type:

```typescript
import { User } from "./schema/user.as";

const users = db.getTable(User);
const user = await users.findById(1);
```

Run `npx asc db sync` to create or update collections and indexes. See [Schema Sync](../sync/) for details.

## MongoDB-Specific Annotations

These annotations are available when the MongoDB plugin is registered. They extend the generic `@db.*` namespace with MongoDB-specific behavior.

| Annotation                                             | Level     | Purpose                                       |
| ------------------------------------------------------ | --------- | --------------------------------------------- |
| `@db.mongo.collection`                                 | Interface | Mark as MongoDB collection, auto-inject `_id` |
| `@db.mongo.capped size, max?`                          | Interface | Capped collection with size limit             |
| `@db.mongo.search.dynamic analyzer?, fuzzy?`           | Interface | Dynamic Atlas Search index                    |
| `@db.mongo.search.static analyzer?, fuzzy?, indexName` | Interface | Named static Atlas Search index               |
| `@db.mongo.search.text analyzer?, indexName`           | Field     | Include field in search index                 |

All generic `@db.*` annotations (`@db.table`, `@db.index.*`, `@db.default.*`, `@db.rel.*`, `@db.json`, `@db.search.vector`, `@db.search.filter`, etc.) work with MongoDB as well. See the [Annotations Reference](./annotations) for the full list.

## Primitives

### `mongo.objectId`

A string type constrained to 24-character hex strings matching the MongoDB ObjectId format. Used for `_id` fields. At runtime, the adapter converts these strings to native `ObjectId` instances automatically.

```atscript
@db.table 'users'
@db.mongo.collection
export interface User {
    // _id: mongo.objectId is auto-injected by @db.mongo.collection
    name: string
}
```

### `mongo.vector`

An alias for `number[]`, used as a semantic marker for embedding fields. Paired with `@db.search.vector` to declare vector search indexes.

```atscript
@db.search.vector 1536, 'dotProduct', 'embeddings_idx'
embedding: mongo.vector
```

## Primary Keys & \_id

MongoDB always uses `_id` as the document primary key. The adapter enforces this regardless of your schema:

- **Auto-injection** — `@db.mongo.collection` adds `_id: mongo.objectId` if not declared. The `_id` field is always non-optional.
- **Custom `@meta.id` fields** — Marking a non-`_id` field with `@meta.id` does not make it a MongoDB primary key. Instead, the adapter creates a unique index on it and registers it for fallback lookups.
- **`findById` resolution** — First tries `_id`, then falls back to fields marked with `@meta.id`. So `findById(42)` works when `42` is an auto-incremented `id` field rather than an ObjectId.
- **`prepareId()` conversion** — Automatically converts string IDs to `ObjectId` instances (for `mongo.objectId` fields) or to numbers (for numeric `_id` fields), so you can pass string values from URL parameters directly.

```typescript
// All of these work:
await users.findById(new ObjectId("507f1f77bcf86cd799439011")); // by _id
await users.findById("507f1f77bcf86cd799439011"); // string -> ObjectId
await users.findById(42); // by @meta.id field
```

**ID types**: ObjectId (default), string, or number.

## Auto-Increment

The `@db.default.increment` annotation enables auto-increment behavior for numeric fields:

```atscript
@meta.id
@db.default.increment
id: number
```

The adapter uses an `__atscript_counters` collection for atomic sequence allocation via `findOneAndUpdate` with `$inc`. Each counter is keyed by `{collection}.{field}`.

- On `insertOne`, the counter is atomically incremented by 1 and the value is assigned.
- On `insertMany`, the counter is incremented by the batch size to pre-allocate a range. Values are assigned in order.
- If a document already has an explicit value for the field, that value is used as-is and no counter allocation occurs. Note: this does **not** advance the counter, so subsequent auto-incremented values may collide with manually provided ones. Pair with `@db.index.unique` to catch duplicates.

::: warning
Concurrent inserts under high contention could produce duplicate values in rare cases. For guaranteed uniqueness, combine `@db.default.increment` with `@db.index.unique`.
:::

## Nested Objects

Unlike relational databases where nested objects are flattened into `__`-separated columns, MongoDB stores nested objects natively. The adapter skips flattening entirely — nested JavaScript objects are passed through to MongoDB as-is and read back without reconstruction.

```atscript
@db.table 'users'
@db.mongo.collection
export interface User {
    @meta.id
    @db.default.increment
    id: number

    name: string

    contact: {
        email: string
        phone?: string
    }
}
```

Dot-notation queries work directly:

```typescript
const result = await users.findMany({
  filter: { "contact.email": "alice@example.com" },
  controls: { $sort: { "contact.phone": 1 } },
});
```

::: tip
The `@db.json` annotation has no effect on MongoDB — there is no flattening to override. You can still use it for documentation purposes, but it does not change storage behavior.
:::

## Native Patch Pipelines

MongoDB uses aggregation pipelines for array patch operations instead of the read-modify-write cycle used by relational adapters. All five patch operators are supported:

- **`$insert`** — Append items to an array
- **`$remove`** — Remove items matching a condition
- **`$update`** — Update matching items in place
- **`$upsert`** — Update if exists, insert if not
- **`$replace`** — Replace the entire array

This is transparent to your code — the same patch API works across all adapters, but MongoDB executes updates atomically on the server using `$concatArrays`, `$filter`, `$map`, and other aggregation operators.

See [Patch Operations](/api/update-patch) for the full API.

## Native Relation Loading

The adapter uses MongoDB `$lookup` aggregation stages for TO, FROM, and VIA relations instead of issuing separate queries. This means relation loading happens in a single round-trip to the database.

- **TO relations** — `$lookup` with `localField` / `foreignField`
- **FROM relations** — Reverse `$lookup` from the related collection
- **VIA relations** — Two-stage `$lookup` through the junction collection

Relation controls (`$sort`, `$limit`, `$filter`) are applied as pipeline stages within the `$lookup`. Nested lookups (relations of relations) are supported.

See [Relations](/relations/) for details.

## Text Search

Standard MongoDB text search uses the generic `@db.index.fulltext` annotation. This works on **all MongoDB deployments** — standalone, replica sets, and Atlas.

```atscript
@db.table 'articles'
@db.mongo.collection
export interface Article {
    @meta.id _id: mongo.objectId

    @db.index.fulltext 'content_idx'
    title: string

    @db.index.fulltext 'content_idx', 2
    body: string
}
```

Fields sharing the same index name (`'content_idx'`) form a **composite text index**. The optional second argument is a weight — here `body` has weight `2`, making matches in it score twice as high as `title` (default weight `1`).

Query with `search()`:

```typescript
const results = await articles.search("mongodb tutorial");
```

See [Text Search](/search/) for the full guide.

## Atlas Search

Atlas Search brings full-text search powered by **Apache Lucene** to your MongoDB collections. It supports fuzzy matching, language-aware analyzers, and custom scoring — but requires a **MongoDB Atlas** deployment.

### Dynamic Atlas Search

`@db.mongo.search.dynamic` auto-indexes every string field in the collection:

```atscript
@db.table 'products'
@db.mongo.collection
@db.mongo.search.dynamic 'lucene.english', 1
export interface Product {
    @meta.id _id: mongo.objectId
    title: string
    description: string
    category: string
}
```

Arguments:

1. **Analyzer** — the Lucene analyzer to use (e.g., `'lucene.english'`)
2. **Fuzzy level** — typo tolerance (`0`, `1`, or `2`)

All string fields are searchable immediately with no per-field annotations needed.

### Static Atlas Search

`@db.mongo.search.static` creates a named index where you control exactly which fields are searchable and which analyzer each uses:

```atscript
@db.table 'products'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 0, 'product_search'
export interface Product {
    @meta.id _id: mongo.objectId

    @db.mongo.search.text 'lucene.english', 'product_search'
    title: string

    @db.mongo.search.text 'lucene.standard', 'product_search'
    description: string

    // Not included in the search index
    sku: string
    price: number
}
```

Arguments for `@db.mongo.search.static`:

1. **Default analyzer** — fallback analyzer for the index
2. **Fuzzy level** — typo tolerance
3. **Index name** — identifies the index for queries

Each `@db.mongo.search.text` field can use a different analyzer while belonging to the same named index.

### Supported Analyzers

Atlas Search uses Apache Lucene analyzers. The most common:

| Analyzer            | Description                                               |
| ------------------- | --------------------------------------------------------- |
| `lucene.standard`   | General-purpose tokenizer, lowercases, removes stop words |
| `lucene.english`    | English-specific with stemming ("running" matches "run")  |
| `lucene.simple`     | Lowercases and splits on non-letter characters            |
| `lucene.keyword`    | No tokenization — treats the entire field as one token    |
| `lucene.whitespace` | Splits on whitespace only, no lowercasing                 |

Language-specific analyzers are also available: `lucene.spanish`, `lucene.french`, `lucene.german`, `lucene.chinese`, `lucene.japanese`, and about 20 more. See the [MongoDB Atlas docs](https://www.mongodb.com/docs/atlas/atlas-search/analyzers/) for the full list.

### Fuzzy Search

The fuzzy parameter controls typo tolerance using Levenshtein distance:

- **`0`** — exact match only, no typos allowed
- **`1`** — one character difference allowed (e.g., "mongo" matches "mango")
- **`2`** — two character differences allowed (e.g., "search" matches "saerch")

Higher values increase recall at the cost of precision. For most use cases, `1` is a good default.

### Searching at Runtime

Both text indexes and Atlas Search use the same API:

```typescript
// Basic search (uses the best available index)
const results = await table.search("search query", {});

// Search with filters and pagination
const { data, count } = await table.searchWithCount("query", {
  filter: { category: "tech" },
  controls: { $limit: 20, $skip: 0 },
});

// Target a specific named index
const results = await table.search("query", {}, "product_search");
```

## Vector Search

MongoDB supports vector similarity search via Atlas `$vectorSearch`. Use the generic `@db.search.vector` annotation with the `mongo.vector` primitive:

```atscript
@db.search.vector 1536, 'cosine', 'doc_vectors'
embedding: mongo.vector

@db.search.filter 'doc_vectors'
category: string
```

The adapter builds `$vectorSearch` aggregation pipelines from your schema. No subclassing or callbacks needed — pass a pre-computed embedding vector directly to `vectorSearch()`.

See [Vector Search](/search/vector-search) for the full annotation reference, programmatic API, and HTTP access.

### Index Priority

When multiple search indexes exist on a collection, the adapter selects the default in this order:

1. **Dynamic Atlas Search** index (highest priority)
2. **Static Atlas Search** index
3. **MongoDB text index** (lowest priority)

You can always bypass the priority by passing an explicit index name to `search()`.

## Capped Collections

Capped collections have a fixed maximum size and maintain insertion order (FIFO). They are ideal for logs, event streams, and cache-like data. Once the collection reaches its size limit, the oldest documents are automatically removed.

```atscript
@db.table 'logs'
@db.mongo.collection
@db.mongo.capped 10485760, 10000
@db.sync.method 'drop'
export interface LogEntry {
    message: string
    level: string
    @db.default.now
    timestamp: number.timestamp.created
}
```

The first argument is the maximum size in bytes (10 MB above), and the optional second argument is the maximum number of documents (10,000 above). Changing cap size requires collection recreation. Use `@db.sync.method 'recreate'` to preserve data — sync copies data server-side to a temporary collection via `$out`, drops and recreates with the new options, then copies data back via `$merge`. Use `@db.sync.method 'drop'` if data loss is acceptable (the collection is dropped and recreated empty).

::: warning
Capped collections do not support document deletion or updates that increase document size. They are append-only by design.
:::

## Transactions

MongoDB transactions require a replica set or mongos topology. On standalone instances, the adapter gracefully skips transactional wrapping — operations run normally without guarantees. See [Transactions](/api/transactions#mongodb) for usage and behavioral details.

## Schema Sync Notes

MongoDB uses **snapshot-based** schema sync (Path B — no column introspection):

- Collections are created on demand when first accessed
- Schema sync creates and manages **indexes only** — there are no column-level migrations
- Capped collection option drift (size/max changes) is detected and flagged
- Standard indexes use the `atscript__` prefix so sync only touches managed indexes
- Atlas Search indexes are managed separately from standard MongoDB indexes

See [Schema Sync](../sync/) for the full sync workflow.

## Accessing the Adapter

For operations beyond the standard CRUD interface, access the underlying `MongoAdapter` to use native MongoDB driver methods:

```typescript
const adapter = db.getAdapter(User) as MongoAdapter

// Run an aggregation pipeline
const cursor = adapter.collection.aggregate([
  { $match: { status: 'active' } },
  { $group: { _id: '$department', count: { $sum: 1 } } },
])
const results = await cursor.toArray()

// Use any MongoDB driver method
await adapter.collection.distinct('status')
await adapter.collection.bulkWrite([...])
```

You can also access the adapter through a table handle:

```typescript
const users = db.getTable(User);
const adapter = users.getAdapter();
const collection = adapter.collection; // native MongoDB Collection
```

## Limitations

- **FK constraints emulated** — referential integrity is enforced in the generic layer, not by MongoDB itself
- **Atlas Search requires Atlas** — not available on self-hosted MongoDB
- **Vector search requires Atlas M10+** — minimum tier for vector search indexes
- **No SQL views** — MongoDB does not have SQL-style views; use aggregation pipelines instead
- **Transactions require replica set** — standalone MongoDB instances cannot use transactions
- **Embeddings are external** — pass pre-computed vectors to `vectorSearch()`, the adapter does not generate them
- **Atlas Search indexes build asynchronously** — they may take a few seconds to become available after creation

## Next Steps

- [Adapter Overview](./) — feature comparison across all adapters
- [PostgreSQL](./postgresql) — full-featured adapter with pgvector and transactional DDL
- [SQLite](./sqlite) — zero-config adapter for development and testing
- [CRUD Operations](/api/crud) — full `AtscriptDbTable` API reference
- [Schema Sync](../sync/) — sync workflow, CLI, and CI/CD
