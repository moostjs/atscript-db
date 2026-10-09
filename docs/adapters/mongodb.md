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
import { MongoPlugin } from "@atscript/db-mongo";

export default defineConfig({
  plugins: [ts(), dbPlugin(), MongoPlugin()],
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

The third argument takes adapter options (since 0.1.151); `createAdapter(uri, options)` accepts the same:

| Option            | Default | Effect                                                                                                                                             |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `estimatedCount`  | `false` | `true` or a list of collection names — see [Estimated counts](#estimated-count)                                                                    |
| `viewJoinPruning` | `true`  | `false` reads managed views as stored — see [unused joins are skipped](/views/querying-views#performance-unused-joins-are-skipped) (since 0.1.153) |

::: tip Optional `mongodb` peer deps
The `mongodb` driver declares several optional peers (e.g. `aws4` for `MONGODB-AWS`, `kerberos`, `mongodb-client-encryption`) that pnpm won't install for you. If you hit `MongoMissingDependencyError` in production but not locally, see the [mongodb optional dependencies docs](https://www.mongodb.com/docs/drivers/node/current/get-started/installation/) — this is upstream, not an atscript-db concern.
:::

Or use the convenience helper:

```typescript
import { createAdapter } from "@atscript/db-mongo";

const db = createAdapter("mongodb://localhost:27017/myapp");
```

`createAdapter` creates a `MongoClient` (connection is lazy — established on first query), extracts the database from the connection string, and returns a ready-to-use `DbSpace`.

### Estimated counts {#estimated-count}

An unfiltered count — `count()` with an empty filter, and the total of `findManyWithCount()` (e.g. an unfiltered `GET /pages` over HTTP) — counts every document of the collection, which takes time on a large one. Opt in to read it from the collection metadata (`estimatedDocumentCount`) instead:

```typescript
new MongoAdapter(mongoDb, client, { estimatedCount: ["events", "audit_log"] });
// or every collection:
createAdapter("mongodb://localhost:27017/myapp", { estimatedCount: true });
```

- Only **unfiltered** counts of **collections** are estimated. A filtered count, a count over a view, and any count inside a transaction stay exact.
- The estimate is the collection's document count from its metadata. It can differ from the exact count after an unclean shutdown, and on a sharded cluster it includes orphaned documents.

Once you have a `DbSpace`, get a table handle for any `.as` type:

```typescript
import { User } from "./schema/user.as";

const users = db.getTable(User);
const user = await users.findById(1);
```

Run `npx asc db sync` to create or update collections and indexes. See [Schema Sync](../sync/) for details.

### Connection recipes

**Local replica set (transactions enabled).** MongoDB transactions require a replica set or sharded topology. The simplest local setup is a single-node replica set:

```typescript
const client = new MongoClient("mongodb://localhost:27017/myapp?replicaSet=rs0");
const db = new DbSpace(() => new MongoAdapter(client.db(), client));
```

**Single-node test container (`directConnection`).** When pointing at a single-instance container that advertises itself under a different hostname (e.g., a Testcontainers MongoDB), set `directConnection=true` to skip topology discovery:

```typescript
const client = new MongoClient("mongodb://localhost:27017/test?directConnection=true");
```

**In-process MongoDB for tests (`mongodb-memory-server`).** Spin up an ephemeral MongoDB inside the test process — no Docker required:

```bash
pnpm add -D mongodb-memory-server
```

```typescript
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { DbSpace } from "@atscript/db";
import { MongoAdapter } from "@atscript/db-mongo";

const mongod = await MongoMemoryServer.create();
const client = new MongoClient(mongod.getUri());
const db = new DbSpace(() => new MongoAdapter(client.db("test"), client));

// after tests:
await client.close(); // or `db.close()` when the space was built with `createAdapter()` or `{ onClose: () => client.close() }`
await mongod.stop();
```

For transaction support inside tests, use `MongoMemoryReplSet.create()` instead.

## MongoDB-Specific Annotations

These annotations are available when the MongoDB plugin is registered. They extend the generic `@db.*` namespace with MongoDB-specific behavior.

| Annotation                                                                                                  | Level     | Purpose                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@db.mongo.collection`                                                                                      | Interface | Mark as MongoDB collection, auto-inject `_id`                                                                                    |
| `@db.mongo.capped size, max?`                                                                               | Interface | Capped collection with size limit                                                                                                |
| `@db.mongo.search.dynamic analyzer?, fuzzy?`                                                                | Interface | Dynamic Atlas Search index                                                                                                       |
| `@db.mongo.search.static analyzer?, fuzzy?, indexName?, strategy?`                                          | Interface | Named static Atlas Search index. Repeatable. `indexName?` defaults to `"DEFAULT"`. `strategy?`: `compound`/`autocomplete`/`text` |
| `@db.mongo.search.text analyzer?, indexName?`                                                               | Field     | Include field in a search index as a **word-matched** field. Repeatable. `indexName?` defaults to `"DEFAULT"`                    |
| `@db.mongo.search.autocomplete indexName?, tokenization?, minGrams?, maxGrams?, foldDiacritics?, analyzer?` | Field     | Include field as a **prefix/typeahead** field (double-mapped as `string`)                                                        |

All generic `@db.*` annotations (`@db.table`, `@db.index.*`, `@db.default.*`, `@db.rel.*`, `@db.json`, `@db.search.vector`, `@db.search.filter`, etc.) work with MongoDB as well. See the [Annotations Reference](./annotations) for the full list.

## Primitives

### `mongo.objectId`

A string type constrained to 24-character hex strings matching the MongoDB ObjectId format. Used for `_id` fields and ObjectId FK reference columns.

```atscript
@db.table 'users'
@db.mongo.collection
export interface User {
    // _id: mongo.objectId is auto-injected by @db.mongo.collection
    name: string
}
```

In application code the value is always the hex **string** — the adapter maps it to and from native `ObjectId` at the storage boundary for every top-level `mongo.objectId` column (including arrays of them):

- **Filters** — hex strings coerce to `ObjectId` in equality, operator (`$in`, `$ne`, ...), `$or`/`$and` positions. `{ leadId: '<hex>' }` matches natively stored ObjectIds, so id envelopes and FK filters work symmetrically with reads.
- **Writes** — hex strings are stored as native `ObjectId`; `insertedId` comes back as a hex string.
- **Reads** — natively stored `ObjectId` values are returned as hex strings, matching the declared type.

Non-hex strings and existing `ObjectId` instances pass through untouched. Fields nested inside embedded objects are stored verbatim (as strings) — the mapping applies to top-level columns only.

### `db.vector`

Vector embedding fields use the core `db.vector` primitive (`number[]`, registered by `dbPlugin()`) — there is no Mongo-specific vector primitive. Pair it with `@db.search.vector` to declare a vector search index.

```atscript
@db.search.vector 1536, 'dotProduct', 'embeddings_idx'
embedding: db.vector
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
- Inside a transaction the allocation runs on its session (since 0.1.151): a rollback returns the values, and two transactions allocating for the same field conflict and are retried like any write conflict. Before 0.1.151 the counter moved outside the transaction.
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

Dotted paths into `@db.json` objects and arrays of objects (`prefs.theme`, `items.sku`) are real query paths here: they are listed in `/meta.fields` and accepted by filters, `$sort`, `$select` and `$groupBy` (SQL adapters reject them with 400). The array / `@db.json` column itself is filterable (implicit `$in` on arrays) but **never sortable** — since 0.1.128 `$sort=tags` / `$sort=prefs` is rejected with 400 (`canSortField` vetoes array and JSON design types; min/max-element ordering is a footgun for generic sort headers), and `/meta` says `sortable: false`. Navigation descendants (`author.name`) are no longer listed in `/meta.fields` since 0.1.128 — load relations with `$with`.

::: warning `$exists` ignores key presence since 0.1.132
`$exists` means "the field holds a value" on every adapter, so a document storing `note: null` no longer matches `{ note: { $exists: true } }` — the adapter sends `{ note: { $ne: null } }` / `{ note: null }` instead of native `$exists`. Filters that counted a `null`-valued key as present now return different rows. See [Existence](/api/queries#existence).
:::

## Renamed Fields (`@db.column`) {#renamed-fields}

A field renamed with `@db.column 'physical_name'` is addressed by its logical name everywhere. Since 0.1.132 that includes `$select` and `$sort` on `findMany` / `findOne` / `findManyWithCount` and their search, vector and geo variants, filters on dotted paths under a renamed object, and grouped queries (`$groupBy`, aggregate fields, `$sort`, `$having`). Up to 0.1.131 a renamed field was dropped from `$select`ed rows, silently ignored in `$sort`, and mapped to the wrong key in grouped queries.

MongoDB renames **top-level** keys only:

```atscript
@db.column 'prof'
profile: {
    bio: string        // stored at prof.bio — the renamed parent renames the first segment
}

address: {
    @db.column 'zip_code'
    zip: string        // stored at address.zip — a nested @db.column is ignored here
}
```

- A field under a renamed object is addressed at its stored path everywhere — filters, sorts, patches, `$inc` / `$mul` and indexes (`@db.index.*` on `profile.bio` indexes `prof.bio`).
- A `@db.column` (and `@db.column.renamed`) on a nested field has no effect on MongoDB: the field is written, filtered, sorted, grouped, indexed and read by views at its logical path (`address.zip`). SQL adapters still flatten it to `address__zip_code`, so one model can serve both.
- Changing or removing a nested `@db.column` is not a schema change on MongoDB — sync reports nothing. Upgrading from 0.1.136: see [Upgrading → 0.1.137](/guide/upgrading#v0-1-137).

## Grouped Queries and Calendar Buckets {#calendar-buckets}

A read whose `$sort` carries a [NULL placement](/api/queries#nulls) (since 0.1.153) runs as an aggregation pipeline instead of `find()`: a computed null flag per placed key, then `$sort`, then the flags are removed (`allowDiskUse` is set). The sort cannot use an index; a `$limit` keeps it a top-k sort. Reads without `$nulls`, or whose entries were dropped (required fields), still use `find()`.

[Grouped queries](/api/aggregation) compile to a `$group` pipeline. Since 0.1.132 a `null` and a missing grouped value form one `null` group, as on the SQL adapters (earlier versions returned two groups). `sum` over a group with no non-null value is `null` here too (since 0.1.148; it was `0`).

[Calendar buckets](/api/calendar-buckets) use `$dateToString`, `$dateToParts` and `$dateFromParts`, so they need **MongoDB 4.0 or later**. Zones come from the server's bundled time zone database; a zone it does not know fails with `BUCKET_TZ_UNAVAILABLE` (HTTP 501) — upgrade the server to get newer zone data.

### Aggregate expressions {#aggregate-expressions}

[Arithmetic and `first` / `last`](/api/aggregation#arithmetic-expressions) use `$toDouble` operands (MongoDB 4.0+). `first` / `last` put a `$sort` on `$rowOrder` plus the `_id` before `$group` and take `$first` / `$last` — the form that works from MongoDB 3.6. That `$sort` covers every matching document, so such a pipeline runs with `allowDiskUse`; index `(group key, $rowOrder fields…, _id)` to keep it cheap.

A `sum` over a group with no non-null value is `null`, as in SQL (MongoDB's own `$sum` gives `0`; the pipeline counts the values next to the sum). That holds for a plain `sum` too, since 0.1.148.

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

- **TO relations** — `$lookup` into the target collection on its key
- **FROM relations** — Reverse `$lookup` from the related collection on its foreign key
- **VIA relations** — Two-stage `$lookup` through the junction collection

Each lookup joins with an `$expr` `$eq` per key field, so an index on the related collection's key fields is used — see [Indexes](#relational-predicate-indexes).

A `$with` entry's `filter` and its controls (`$sort`, `$skip`, `$limit` — per parent row) are applied as pipeline stages within the `$lookup`. Nested lookups (relations of relations) are supported.

Since 0.1.147 native loading matches the other adapters:

- **Renamed fields work.** Lookups join on the stored names of `@db.column`-renamed foreign keys and related fields, and the sub-query's filter, `$sort` and `$select` use logical names like any other query. Loaded rows come back with logical names, decrypted, with ObjectIds as hex strings. Before, a renamed key loaded nothing.
- **[`@db.rel.filter`](/relations/navigation#db-rel-filter) is applied.**
- **Sub-queries are validated** like on the other adapters — an unknown field in a `$with` filter is a `DbError`, not an empty result — and may contain [relational predicates](#relational-predicates).
- **A `null` or missing foreign key loads nothing** (`null` / `[]`), also against related documents whose key is `null` or missing.
- **VIA:** `$sort`, `$skip`, `$limit` and `$select` apply per parent row (they applied per junction row), and composite junction keys work. Every adapter pages `$with` per parent row — see [Per-Relation Controls](/relations/loading#per-relation-controls).

See [Relations](/relations/) for details.

## Relational Predicates {#relational-predicates}

[`$some` / `$none` filters](/api/queries#relational-filters) (since 0.1.147) run as correlated `$lookup` stages, so a read whose filter holds one switches to an **aggregation pipeline** — `find`, `findOne`, `count`, `findManyWithCount`, grouped `aggregate()`, text, vector and geo search. Reads without a predicate keep their plain `find` / `countDocuments` path.

- The predicate-free top-level conditions are `$match`ed **before** the lookups, so lookups run only for rows that survive them. Each lookup stops at the first related document.
- `count` with a predicate is an aggregation with `$count` — slower than `countDocuments`.
- Text and vector search: the predicate stages follow the leading `$search` / `$text` / `$vectorSearch` stage. A vector search applies them after its own top-k cut (only [pre-filter](/search/vector-search#pre-filtering) conditions move into `$vectorSearch`). Geo: the predicate-free part stays in the `$geoNear` query and the predicates follow it, so the result is exact.
- A `null` or missing foreign key (any part of a composite one) never relates — `$some` false, `$none` true — even against related documents whose key is `null` or missing.

**Writes.** `updateMany`, `replaceMany`, `deleteMany` and single-row writes scoped by a predicate first resolve the matching `_id`s through the pipeline, then write by `_id` in batches of 1,000, re-checking the predicate-free conditions at write time; the counts are summed across batches. The ids are read from the cursor batch by batch (sorted by `_id`, with `allowDiskUse` so a large match can spill to disk on servers before 6.0), never all at once, and they compare [collated fields](#relational-predicate-collation) like a read does.

::: warning Atomic only inside a transaction
Inside [`withTransaction`](/api/transactions#adapter-behavior) (replica set or mongos) both steps share the session and the write is atomic. Without a transaction there is a window between resolving the ids and writing: a related document can change in between, so a written document may no longer satisfy the predicate, or a document that just started to match is missed. The adapter does not open a transaction by itself — wrap the call in `withTransaction` when that matters.
:::

### Collation {#relational-predicate-collation}

A plain read on a table with `@db.column.collate` fields passes a query-level `collation` when its filter touches one of them. A pipeline with predicates can't do that: one collation would govern every `$lookup` as well, joining `'T1'` to `'t1'` and making the related table's byte-wise fields case-insensitive. So these pipelines run **without** a collation, and each table's `'nocase'` fields — the queried table's and every related table's — are compared case-insensitively on their own: `$eq`, `$ne`, `$in` and `$nin` on a string become an exact, case-insensitive regular-expression match. Join keys and the other fields compare byte-wise.

- These comparisons cannot use an index the way a collated plain read can, so put selective conditions on other fields.
- A range (`$gt`, `$gte`, `$lt`, `$lte`) on a string of a `'nocase'` field, and any string comparison on a `'unicode'` field, can't be rendered this way. They throw `REL_FILTER_NOT_SUPPORTED` (HTTP 400) when the query holds a predicate. `$regex` and `$exists` are fine — `$regex` never follows a collation.
- `$sort` in such a query is byte-wise.
- Writes without a predicate pass no collation at all, so their filter compares `'nocase'` fields byte-wise. A write with a predicate compares them like a read (see above).
- A [`$with`](#native-relation-loading) sub-filter that holds a predicate follows these rules too. A `$with` sub-filter without one compares byte-wise, because native `$with` loading passes no collation.

### Indexes {#relational-predicate-indexes}

Each lookup (predicates and [`$with`](#native-relation-loading)) correlates with a bare `$expr` `$eq` per key field, then drops `null` keys in a separate `$match`, so MongoDB 5.0 and later run it as an index scan on the related collection's key fields — without an index, every source document scans the whole related collection. Index:

- the foreign-key field of the related collection for a `@db.rel.from` relation (`issues.ticketKey` for `tickets.issues`);
- both foreign-key fields of a `@db.rel.via` junction;
- a composite key with one compound index over its fields.

A `@db.rel.to` relation reads the target's `_id`, or a non-`_id` `@meta.id` field, which has a unique index.

**Sorted pages.** `$sort`, `$skip` and `$limit` run **after** the lookups. Every document that passes the predicate-free conditions is looked up before the page is cut, so the cost grows with the number of candidates, not with the page size, and an index on the sort field does not shorten it. Narrow the candidates with predicate-free conditions where you can.

### Building Filters Yourself

`buildMongoFilter(filter)` throws `REL_FILTER_NOT_SUPPORTED` on a predicate, since a `$lookup` cannot live in a `find` filter. For a raw-driver aggregation over a translated filter that may hold predicates, use `mongoFilterStages(filter)` (the stages to put at the start of your pipeline), or `buildMongoQuery(filter)` → `{ pre?, lookups, match, temp }` with `planStages(plan)` for finer placement.

- Run that aggregation without a `collation`. To compare the queried table's `'nocase'` fields as described in [Collation](#relational-predicate-collation), pass its per-field collation as the second argument: `mongoFilterStages(filter, { collation: (field) => adapter.fieldCollation(field) })`. Related tables use their own automatically.
- The lookups write temporary `__atscript_rf_<n>` fields (`temp`). `mongoFilterStages` / `planStages` remove them with `$unset`.

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

MongoDB keeps **one** text index per collection, so a table may declare only one `@db.index.fulltext` name with text (string) members: a second one throws when the table metadata is built. Extra fulltext names that hold only integer members are fine and are addressable with `$index=<name>`.

The term is handed to `$text`, so MongoDB's operators apply natively: a plain list of words matches **any** of them, `"a phrase"` matches the phrase, and `-word` excludes a word (a term made only of negations matches nothing). Results are ranked by `textScore`.

**Integer members** are not part of the text index (it ignores numbers); the text index and its weights cover the string members only. When the whole search term is a whole number the stage becomes

```js
{
  $match: {
    $or: [{ $text: { $search: "2946" } }, { refNo: { $eq: 2946, $type: "number" } }];
  }
}
```

MongoDB requires **every** `$or` branch next to `$text` to be index-backed (otherwise error 291), so an integer member must be [index-backed](/search/#integer-fields-exact-number-match) — schema validation enforces it. The `$type` guard lets an **optional** unique member's partial index (`{ f: { $type: "number" } }`) serve the equality. Equality-only rows carry no text score and sort after the text hits. An index of integer members only has no text index; a term that is not a whole number then matches nothing.

`$regex` on an integer field renders `$expr` / `$regexMatch` over `$toString` of `$convert`ed long (so `10^16` prints as `10000000000000000`, not `1e+16`).

See [Text Search](/search/) for the full guide.

## Atlas Search

Atlas Search brings full-text search powered by **Apache Lucene** to your MongoDB collections. It supports fuzzy matching, language-aware analyzers, and custom scoring — but requires a **MongoDB Atlas** deployment.

### Integer members in Atlas

An integer member of an `@db.index.fulltext` is searched with an Atlas `equals` clause OR'd (compound `should`, `minimumShouldMatch: 1`) with the text clause when the whole term is a whole number. A static `@db.mongo.search.static` index gets a `{ type: "number" }` mapping for every integer member automatically (schema sync updates the index once); a dynamic index already indexes numbers.

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

::: warning Dynamic mapping and `@db.writeOnly` {#dynamic-write-only}
A dynamic mapping indexes every string field, including a sealed `@db.writeOnly` one, so a hit would reveal the sealed value. moost-db therefore refuses `$search` (400) and reports `searchable: false` on a model that combines `@db.mongo.search.dynamic` with any `@db.writeOnly` field. Switch to a static `@db.mongo.search.text` mapping that omits the sealed fields.
:::

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
2. **Fuzzy level** — query-time typo tolerance (see [Fuzzy Search](#fuzzy-search))
3. **Index name** — identifies the index for queries (the `$index` control)
4. **Strategy** — the query shape: `compound` (default), `autocomplete`, or `text` (see [Match Strategy](#match-strategy))

Each `@db.mongo.search.text` field can use a different analyzer while belonging to the same named index.

### Autocomplete & Typeahead

A plain search index matches whole words — `"art"` will not match `"Artem"`. For **as-you-type** matching, annotate the field with `@db.mongo.search.autocomplete`:

```atscript
@db.table 'users'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 0, 'people'
export interface User {
    @meta.id _id: mongo.objectId

    @db.mongo.search.autocomplete 'people'
    username: string
}
```

This indexes the field as an Atlas `autocomplete` type **and** double-maps it as a plain `string`, so exact-word hits still rank. Now `?$search=art` matches `"Artem"` as you type.

The `tokenization` argument picks how partial matching works:

| `tokenization`       | Matches                       | Example               |
| -------------------- | ----------------------------- | --------------------- |
| `edgeGram` (default) | **prefix** — start of a word  | `"art"` → `"Artem"`   |
| `nGram`              | **substring** — inside a word | `"tem"` → `"Artem"`   |
| `rightEdgeGram`      | **suffix** — end of a word    | `"sev"` → `"Maltsev"` |

`edgeGram` (prefix) covers the typical search-box case at the lowest index cost; reach for `nGram` only when you need true mid-word matching (larger index, slower builds). Other arguments default to `minGrams: 2`, `maxGrams: 15`, `foldDiacritics: true` (so `"cafe"` matches `"café"`).

### Match Strategy

The `strategy` argument on `@db.mongo.search.static` locks how a term is matched against the index — there is no per-query mode switching:

| `strategy`           | Query shape                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compound` (default) | Word match **and** prefix — exact-word hits rank above prefix hits. Falls back to plain word match when the index has no autocomplete field (so unset behaves like before). |
| `autocomplete`       | Prefix/typeahead **only** — no word-match clause.                                                                                                                           |
| `text`               | Word matching **only** — ignores autocomplete tokenization.                                                                                                                 |

```atscript
@db.mongo.search.static 'lucene.english', 0, 'people_prefix', 'autocomplete'
```

`strategy` affects only the query — the Atlas index definition is identical regardless.

### Search Variants

Each index encodes one behavior. To match the **same field** different ways, declare a second index and select it per request with `$index` — one field can join several indexes:

```atscript
@db.table 'users'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 0, 'users_exact'                    // word match
@db.mongo.search.static 'lucene.english', 1, 'users_prefix', 'autocomplete'   // typeahead + fuzzy
export interface User {
    @meta.id _id: mongo.objectId

    @db.mongo.search.text 'lucene.english', 'users_exact'
    @db.mongo.search.autocomplete 'users_prefix'
    username: string
}
```

`?$search=art` → the first-declared index (`users_exact`, word match). `?$search=art&$index=users_prefix` → the typeahead variant. Same data, two locked behaviors, no query-time modes.

### Supported Analyzers

Atlas Search uses Apache Lucene analyzers. The plugin whitelists the following values:

| Analyzer            | Description                                               |
| ------------------- | --------------------------------------------------------- |
| `lucene.standard`   | General-purpose tokenizer, lowercases, removes stop words |
| `lucene.simple`     | Lowercases and splits on non-letter characters            |
| `lucene.whitespace` | Splits on whitespace only, no lowercasing                 |
| `lucene.english`    | English-specific with stemming ("running" matches "run")  |
| `lucene.french`     | French stemming and stop words                            |
| `lucene.german`     | German stemming and stop words                            |
| `lucene.italian`    | Italian stemming and stop words                           |
| `lucene.portuguese` | Portuguese stemming and stop words                        |
| `lucene.spanish`    | Spanish stemming and stop words                           |
| `lucene.chinese`    | Chinese tokenization                                      |
| `lucene.hindi`      | Hindi tokenization                                        |
| `lucene.bengali`    | Bengali tokenization                                      |
| `lucene.russian`    | Russian stemming and stop words                           |
| `lucene.arabic`     | Arabic stemming and stop words                            |

See the [MongoDB Atlas docs](https://www.mongodb.com/docs/atlas/atlas-search/analyzers/) for descriptions and tokenization rules.

### Fuzzy Search

The fuzzy parameter controls typo tolerance using Levenshtein edit distance, applied **at query time** to the search operator. Declare it on the index (`@db.mongo.search.static`/`.dynamic`) and it applies to every `$search` automatically:

- **`0`** (default) — no fuzzy, exact tokens only
- **`1`** — one edit allowed (e.g., "mango" matches "mongo")
- **`2`** — two edits allowed (e.g., "saerch" matches "search")

Atlas only honors an edit distance of `1` or `2`; `0` simply disables it. Higher values increase recall at the cost of precision — `1` is a good default.

Callers can override the declared value per request with the `$fuzzy` control: `?$search=mongo&$fuzzy=2` widens tolerance, `?$search=mongo&$fuzzy=0` disables it for that one request. See [HTTP — Relations & Search](/http/advanced#text-search).

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

`searchWithCount` on an Atlas Search index with **no filter** reads the page directly and takes the total from the search metadata (`$searchMeta` with `count: { type: "total" }`), so only the page's documents are fetched (since 0.1.151). With a filter, a classic text index or a vector index, the rows and the total come from one `$facet` over every match. A plain `findManyWithCount` without relational predicates runs a `find` plus a `countDocuments` (concurrently; one after the other inside a transaction).

Running your own `$search` pipeline with the raw MongoDB driver instead of `table.search()`? You must pass the **physical** index name (`atscript__search_text__product_search`), not the logical annotation name — see [Physical index names (raw-driver `$search`)](#physical-index-names-raw-driver-search).

## Vector Search

MongoDB supports vector similarity search via Atlas `$vectorSearch`. Use the generic `@db.search.vector` annotation with the `db.vector` primitive:

```atscript
@db.search.vector 1536, 'cosine', 'doc_vectors'
embedding: db.vector

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

The first argument is the maximum size in bytes (10 MB above), and the optional second argument is the maximum number of documents (10,000 above). Changing cap size requires collection recreation. Use `@db.sync.method 'recreate'` to preserve data — sync creates a temporary collection (`<name>__tmp_<timestamp>`) with the new options, copies the documents into it server-side via `$merge`, then swaps it in with one atomic `renameCollection` (`dropTarget`). Since 0.1.139 the original is untouched until that swap: a failed step drops the temporary collection and the original keeps its documents and options. Before, the original was dropped first, and a failure could leave the documents only in the temporary collection. Use `@db.sync.method 'drop'` if data loss is acceptable (the collection is dropped and recreated empty).

::: warning
Capped collections do not support document deletion or updates that increase document size. They are append-only by design.
:::

## Transactions

MongoDB transactions require a replica set or mongos topology. On standalone instances, the adapter gracefully skips transactional wrapping — operations run normally without guarantees. See [Transactions](/api/transactions#adapter-behavior) for usage and behavioral details.

## Schema Sync Notes

MongoDB uses **snapshot-based** schema sync (Path B — no column introspection):

- Collections are created on demand when first accessed
- Schema sync creates and manages **indexes only** — there are no column-level migrations
- Capped collection option drift (size/max changes) is detected and flagged
- **Indexes follow the fields' collation** (since 0.1.151). A plain or unique index over a `@db.column.collate 'nocase'` field is built with collation `{ locale: "en", strength: 2 }`, over a `'unicode'` field with `strength: 1` (`'unicode'` wins in a compound index) — the collation a read filtering on that field passes, so the read uses the index. A collated **unique** index enforces uniqueness under that collation: with `'nocase'`, `"Ann@x"` and `"ann@x"` conflict. In a compound index the one collation applies to every string field in it, so a byte-wise field in a unique index with a `'nocase'` field is compared case-insensitively too. Sync compares the existing index's collation and drops and recreates the index when it differs; an index that inherited the collection's default collation counts as byte-wise. Before replacing a unique index, sync checks the data against the new one: if existing documents would conflict, it keeps the current index and reports the duplicate key. Text and `2dsphere` indexes stay byte-wise.
- Standard indexes use the `atscript__` prefix so sync only touches managed indexes
- Atlas Search indexes are managed separately from standard MongoDB indexes
- **Unique indexes over optional fields are partial.** A `@db.index.unique` that includes an optional field gets a `partialFilterExpression` restricting it to documents where the optional field is present — so many documents may lack the field while present values stay unique, matching SQL's `NULLS DISTINCT` behavior. Changing a field's optionality changes the filter, which drops and recreates the index on the next sync.
- **Derived columns store nothing.** A [`@db.column.derived`](/api/storage#derived-columns) field (since 0.1.141) has no document key of its own: filters, sorts, projections, `$groupBy` and indexes address its source path (`payload.customer.id`, `@db.column` renames applied), reads copy the value as stored (no type guard — a value of another type written outside atscript-db passes through, a missing leaf reads as `null`), and sync never `$unset`s or backfills the source leaf; only the index over the source path is managed.

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

### Physical index names (raw-driver `$search`)

Schema sync provisions every managed index under a physical name of the form `atscript__<type>__<cleanName>`, where `<cleanName>` is the logical name from the annotation (illegal characters replaced with `_`, runs collapsed, clamped to MongoDB's 127-character limit). For Atlas Search, `@db.mongo.search.static 'lucene.english', 0, 'product_search'` provisions the physical index `atscript__search_text__product_search`. `<type>` is `search_text` (static), `dynamic_text` (dynamic), or `vector` (`@db.search.vector`).

`table.search()` and `table.vectorSearch()` resolve this for you. But a **raw** `$search` aggregation must pass the **physical** name — Atlas `$search` with the logical annotation name silently returns **zero documents** rather than erroring. Resolve it with the exported `mongoIndexKey` helper instead of hardcoding the prefix scheme:

```typescript
import { mongoIndexKey, INDEX_PREFIX } from "@atscript/db-mongo";

const adapter = db.getAdapter(Product) as MongoAdapter;
const indexName = mongoIndexKey("search_text", "product_search");
// → "atscript__search_text__product_search"

const cursor = adapter.collection.aggregate([
  { $search: { index: indexName, text: { query: "wireless", path: "title" } } },
]);
const results = await cursor.toArray();
```

`mongoIndexKey(type, logicalName)` and `INDEX_PREFIX` are the same helpers schema sync uses, so the resolved name always matches what was provisioned — if the prefix scheme ever changes, your interop code tracks it automatically.

## Views

Managed [views](../views/) become native MongoDB views (`createCollection` with `viewOn` + an aggregation pipeline). Each join becomes a `$lookup` + `$unwind`; field paths are the physical document paths (a `@db.column` renames a top-level key only — see [Renamed Fields](#renamed-fields)), joined documents live under `__joined_<table>` — `__joined_<Alias>` for a [join alias](../views/#join-aliases-and-self-joins), whose `$lookup.from` is still the physical collection. A [view over a view](../views/#views-over-views) is a view whose `viewOn` (or `$lookup.from`) is another view; MongoDB resolves the chain at read time.

| Join condition                                                                                                                               | `$lookup` form                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| a single `=` between a field of the joined table and a field of the entry or an earlier join, where the joined table's field is **required** | `localField` / `foreignField` (index-friendly) |
| anything else — optional join field, `and` / `or`, `<` / `>=` / `!=`, `in`, …                                                                | `let` + `pipeline: [{ $match: { $expr } }]`    |

Null semantics follow SQL:

- A null or missing join key never matches (the simple form is only used where the joined field can't be null or missing). `<`, `<=`, `>`, `>=`, `!=`, `not in` and field-to-field `=` are false when an operand is null or missing.
- **Divergence:** `not (…)` over a comparison with a null operand is **true** on MongoDB and UNKNOWN (row excluded) on SQL.
- An inner join (the default) drops unmatched documents; a `'left'` join keeps them and its fields read back as `null`.
- A view field whose source may be missing — a left-joined table, an optional field, a leaf inside a `@db.json` field — is projected as `{ $ifNull: [source, null] }`, so it reads back as `null`. Every other field stays a plain path, so a filter or sort on the view can still use the source collection's indexes.
- `matches` is not supported in join conditions (`$regexMatch` needs MongoDB 4.2); it still works in `@db.view.filter`, which is a regular `$match`.
- `@db.view.filter` and `@db.view.having` use [query](../api/queries) semantics: `!=` also matches documents where the field is null or missing, `exists` means "holds a value" (a stored `null` counts as absent), `not exists` its negation, and `matches` accepts `/pattern/flags`.
- A field-to-field comparison in `@db.view.filter` / `@db.view.having` (`` `Item.qty > Item.cap` ``, any of `=`, `!=`, `<`, `<=`, `>`, `>=`) is false when either field is null or missing, as on SQL and in join conditions (since 0.1.137; before, a missing field compared below every value, so `7 > missing` matched).
- Aggregates: `sum` over a group with no non-null value is `null`, as on SQL (since 0.1.148; it was `0`).

::: tip Indexes
The pipeline `$lookup` form can't use an index on MongoDB before 5.0. Keep the join field required and the condition a single `=` when the joined collection is large.
:::

### First-row joins and computed columns

Since 0.1.147 a [first-row join](/views/#first-row-joins) always uses the pipeline `$lookup` form, followed by `{ $sort: { <order keys>, <primary key>: 1 } }` and `{ $limit: 1 }` (MongoDB 3.6+). BSON order puts `null` and missing values first, so `NULL` is the smallest order key, as on the SQL adapters.

[Computed columns](/views/computed-columns) render as `$add` / `$subtract` / `$multiply`; `/` is `{ $cond: [{ $eq: [divisor, 0] }, null, { $divide: [...] }] }` (a plain `$divide` by zero is an error), unary minus `$multiply` by `-1`, and `coalesce` nested two-argument `$ifNull` (the multi-argument form needs 5.0). Every field and literal leaf is cast with `$toDouble` (MongoDB 4.0+), so values are doubles as on the SQL adapters. Without the cast, int/long arithmetic would stay exact past 2^53 where SQL rounds. In a grouped view they are evaluated in an `$addFields` after `$group` (before `@db.view.having`).

## Conflict-ignoring inserts {#insert-ignore}

`insertMany(rows, { onConflict: "ignore" })` ([CRUD](/api/crud#insert-ignore)) depends on whether a transaction is active.

- **Outside a transaction** (standalone server, or no `withTransaction`): `insertMany(rows, { ordered: false })`. Write errors with code 11000 mark the skipped rows; any other write error is rethrown after the batch, and rows already written stay (as with a plain non-transactional `insertMany`).
- **Inside a transaction** (replica set): a duplicate key would abort the transaction even with `ordered: false`, so the stored keys are looked up first, inside the session, in chunks of 1000; the matches are skipped and the rest is inserted ordered. A concurrent writer that commits the same key in between is retried by the transaction; a residual duplicate (for example a collation-equal value the plain-equality lookup missed) throws `CONFLICT`, so the call never reports a partial result silently.
- `lockConflicts` ([CRUD](/api/crud#insert-ignore-lock)) is accepted and has no effect: MongoDB has no row locks. Two transactions that write the same document conflict at write time instead, and the losing one is retried by the driver's transaction loop.

## Limitations

- **FK constraints emulated** — referential integrity is enforced in the generic layer, not by MongoDB itself
- **Atlas Search requires Atlas** — not available on self-hosted MongoDB
- **Vector search requires Atlas M10+** — minimum tier for vector search indexes
- **No materialized views** — `@db.view.materialized` creates a plain (on-demand) view; see [Views](#views)
- **Transactions require replica set** — standalone MongoDB instances cannot use transactions, so a write filtered by a [relational predicate](#relational-predicates) is not atomic there
- **Embeddings are external** — pass pre-computed vectors to `vectorSearch()`, the adapter does not generate them
- **Atlas Search indexes build asynchronously** — they may take a few seconds to become available after creation

## Next Steps

- [Adapter Overview](./) — feature comparison across all adapters
- [PostgreSQL](./postgresql) — full-featured adapter with pgvector and transactional DDL
- [SQLite](./sqlite) — zero-config adapter for development and testing
- [CRUD Operations](/api/crud) — full `AtscriptDbTable` API reference
- [Schema Sync](../sync/) — sync workflow, CLI, and CI/CD
