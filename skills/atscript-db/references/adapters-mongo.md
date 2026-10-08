# adapters-mongo

`@atscript/db-mongo` — via `mongodb ^6`. No SQL layer; queries compile to aggregation pipelines, patches to `$set`-stage pipelines.

## Wiring

```ts
import { DbSpace } from "@atscript/db";
import { MongoAdapter } from "@atscript/db-mongo";
import { MongoClient } from "mongodb";

const client = new MongoClient("mongodb://localhost:27017/app");
await client.connect();
const db = new DbSpace(() => new MongoAdapter(client.db(), client));
```

Second `MongoAdapter` arg (the client) is only required for transactions — `session.withTransaction()` needs the client handle, not just the `Db`.

> The `mongodb` driver has optional peer deps (e.g. `aws4` for `MONGODB-AWS`, `kerberos`, `mongodb-client-encryption`) that pnpm won't install. If you hit `MongoMissingDependencyError` only in prod, see the [mongodb optional dependencies docs](https://www.mongodb.com/docs/drivers/node/current/get-started/installation/) — this is not an atscript-db concern.

## Register the plugin

```ts
import { MongoPlugin } from "@atscript/db-mongo"; // also available at the /plugin subpath
plugins: [ts(), dbPlugin(), MongoPlugin()]; // unlocks @db.mongo.*, mongo.objectId
```

## Capabilities

| Capability              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transactions            | `withTransaction(fn)` uses `session.withTransaction()` — requires replica-set (Atlas or local replica).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Native FKs              | No (`supportsNativeForeignKeys: false`) — cascade / setNull run in the application integrity strategy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `supportsNestedObjects` | **Yes** — nested objects stored as-is, not flattened.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Native patches          | Yes (`supportsNativePatch: true`). `CollectionPatcher` emits `$set` aggregation pipelines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Native relation loading | Yes (`supportsNativeRelations: true`) — `$lookup` based. Since 0.1.147: physical names (renamed FKs / fields, sub-filter / `$sort` / `$select`), `@db.rel.filter` applied, sub-queries validated (bad field → `DbError`), NULL FK loads nothing, `via` `$sort`/`$skip`/`$limit`/`$select` per PARENT row (was per junction row), composite `via` keys.                                                                                                                                                                                                                                                                                                                                                                    |
| Full-text search        | **Atlas Search** (`$search` stage) via `@db.mongo.search.static` + `@db.mongo.search.text` — Atlas only. Generic `@db.index.fulltext` → classic `text` index queried via `$text` — works on any deployment; `$text` operators apply natively (`-word`, `"phrase"`, words OR-ed). Integer members are not in the text index; a whole-number term adds `{ col: { $eq: n, $type: "number" } }` to an `$or` next to `$text` (only the integer members of the SEARCHED index — per index; an integer-only index is addressable by `$index`, the default is the first index with a text member; every `$or` branch must be index-backed, error 291 otherwise; Atlas: `equals` clause + `{ type: "number" }` mapping) (0.1.150). |
| Vector search           | **Atlas Search** (`$vectorSearch` stage) via `@db.search.vector` (generic, core annotation).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Column diffing          | N/A — schemaless. `getExistingColumns` is not implemented; sync uses `tableExists()` + snapshot-driven index diffs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| JSON / nested           | Native — `@db.json` is a no-op (store as Document). Dotted paths into JSON objects / arrays of objects are listed in `/meta.fields` and queryable (filter, `$sort`, `$select`, `$groupBy`); the array / JSON column itself is filterable but never sortable (`$sort=tags` → 400 since 0.1.128). Nav descendants are not listed (since 0.1.128).                                                                                                                                                                                                                                                                                                                                                                           |
| Grouped queries         | `$group` pipeline. `null` + missing = ONE group (since 0.1.132; was two). `sum` over no non-null value → `null` (since 0.1.148; was `0`), ungrouped over no rows → one row. Calendar buckets: `$dateToString`/`$dateToParts`/`$dateFromParts` → **MongoDB ≥ 4.0**; unknown zone (code 40485) → `BUCKET_TZ_UNAVAILABLE` 501. → [calendar-buckets.md](calendar-buckets.md)                                                                                                                                                                                                                                                                                                                                                  |

## Managed index prefix & physical index names

**All indexes created by `syncIndexes()` start with `atscript__`.** Indexes not matching the prefix are left alone. Indexes matching the prefix that aren't in the desired set are dropped on drift.

Implication: do not name a consumer-authored index with the `atscript__` prefix.

The physical name of every managed index is `atscript__<type>__<cleanName>`, where `<cleanName>` is the logical name from the annotation, lowercased-safe (illegal chars → `_`, runs collapsed) and clamped to MongoDB's 127-char limit. `<type>` is `search_text` (`@db.mongo.search.static`), `dynamic_text` (`@db.mongo.search.dynamic`, logical name `_`), `vector` (`@db.search.vector`), `unique`/`plain`/`text`/`2dsphere`/`fulltext` for the generic index annotations. So `@db.mongo.search.static 'lucene.english', 1, 'inventory_search'` provisions the Atlas Search index `atscript__search_text__inventory_search`.

**Raw-driver interop.** A consumer hitting an atscript-provisioned collection directly with the `mongodb` driver (e.g. a hand-rolled `$search` aggregation over portal-owned data) must pass the **physical** index name — Atlas `$search` with the logical annotation name silently returns zero documents. Rather than hardcode the scheme, import the helper:

```ts
import { mongoIndexKey, INDEX_PREFIX } from "@atscript/db-mongo";

const indexName = mongoIndexKey("search_text", "inventory_search");
// → "atscript__search_text__inventory_search"
await db.collection("inventory").aggregate([{ $search: { index: indexName /* … */ } }]);
```

`mongoIndexKey(type, logicalName)` and `INDEX_PREFIX` are exported from the package root; they are the same functions schema-sync uses, so the physical name always matches what was provisioned.

## Unique indexes on optional fields are partial

A `@db.index.unique` that includes an optional field is emitted with a `partialFilterExpression` restricting it to documents where the optional field is present — many docs may lack the field while present values stay unique (matches SQL `NULLS DISTINCT`). Composite unique: a doc is exempt as soon as any optional indexed field is missing. Changing a field's optionality changes the filter → index drop+recreate on next sync.

## `@db.mongo.*` annotations

See [mongo-annotations.md](mongo-annotations.md) for the full table.

Removed (use generic core annotations instead):

| Removed                       | Replaced by                       |
| ----------------------------- | --------------------------------- |
| `@db.mongo.index.text`        | `@db.index.fulltext`              |
| `@db.mongo.search.vector`     | `@db.search.vector`               |
| `@db.mongo.search.filter`     | `@db.search.filter`               |
| `@db.mongo.patch.strategy`    | `@db.patch.strategy`              |
| `@db.mongo.array.uniqueItems` | `@expect.array.uniqueItems`       |
| `@db.mongo.autoIndexes`       | — (explicit `syncIndexes()` only) |
| `@mongo.index.plain`          | `@db.index.plain`                 |
| `@mongo.index.unique`         | `@db.index.unique`                |

Capped collections:

| Annotation         | Args                         | Effect                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@db.mongo.capped` | `size: number, max?: number` | Creates a capped collection at `ensureTable()`. `size` = bytes. Resize = destructive option change → `@db.sync.method 'recreate'` (keeps docs) or `'drop'`. Recreate (0.1.139): temp collection with new options ← `$merge` → atomic `renameCollection(dropTarget)`; failure = original untouched, temp dropped (≤ 0.1.138 dropped the original first). |

## Primitives

| Primitive        | Constraint                               |
| ---------------- | ---------------------------------------- |
| `mongo.objectId` | `string` matching `/^[a-fA-F0-9]{24}$/`. |

The Mongo plugin provides only `mongo.objectId`. Vector fields use the core `db.vector` primitive (from `dbPlugin()`), not a Mongo-specific one.

Hex ↔ native `ObjectId` mapping is automatic for every **top-level** `mongo.objectId` column (`_id`, FK columns, arrays of them): filters coerce hex strings in equality/operator/`$in`/`$or` positions, writes store native `ObjectId`, reads and `insertedId` return hex strings. Non-hex strings and `ObjectId` instances pass through. Nested (embedded-object) objectId fields are NOT mapped — they store as strings verbatim. Never hand-convert to `ObjectId` in filters; pass the hex string.

## Atlas Search

Text:

```atscript
@db.table 'articles'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 1, 'main'
interface Article {
    @meta.id _id: mongo.objectId
    @db.mongo.search.text 'lucene.english', 'main'
    title: string
    @db.mongo.search.text 'lucene.english', 'main'
    body: string
}
```

`search('quick brown', query, 'main')` emits an Atlas `$search` first stage. The operator shape depends on the index's fields + `strategy`: a plain `text` operator (word match), an `autocomplete` operator (prefix/typeahead), or a `compound.should` of both. Declared/`$fuzzy` typo tolerance is attached to the operator at query time. For `@db.mongo.search.autocomplete`, `strategy`, query-time `fuzzy`/`$fuzzy`, and the multi-index `$index` variant pattern, see [mongo-annotations.md](./mongo-annotations.md).

The logical name `'main'` is provisioned as the physical index `atscript__search_text__main`; raw-driver `$search` must use that physical name — resolve it with `mongoIndexKey('search_text', 'main')`. See [Managed index prefix & physical index names](#managed-index-prefix--physical-index-names).

Vector:

```atscript
@db.search.vector 1536, 'cosine', 'doc_vec'
embedding: db.vector
```

`vectorSearch(vec, query, 'doc_vec')` uses `$vectorSearch`.

## Patch / CollectionPatcher

Every `updateOne`/`updateMany` patch compiles to a single `[ { $set: <pipeline> } ]` aggregation stage — one round-trip regardless of op count. See [patch.md](patch.md).

## Transactions

```ts
await users.withTransaction(async () => {
  await users.insertOne({ _id: "..." });
  await posts.insertOne({ authorId: "..." });
});
```

Requires a replica set. The adapter uses `session.withTransaction()` internally and propagates the session via `AsyncLocalStorage` to nested tables in the same space.

## Managed views

Native views (`createCollection` + `viewOn` + pipeline); joined docs under `__joined_<table>` (`__joined_<Alias>` for a `@db.alias` join, `$lookup.from` stays the physical collection — 0.1.141); `viewOn` / `$lookup.from` may be a view (views over views, 0.1.141; no revision bump — existing pipelines unchanged); physical document paths (`@db.column` renames a top-level key only — a nested-field `@db.column` is ignored, see Known limits).

| #   | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Simple `$lookup` (`localField`/`foreignField`, index-friendly) ONLY for a single `=` between a joined field and an entry / earlier-join field where the joined field is REQUIRED. Everything else → `let` + `pipeline: [{ $match: { $expr } }]` (no index before MongoDB 5.0) — keep join keys required for large collections.                                                                                                                                                                                               |
| 2   | SQL null semantics in join conditions: null/missing keys never match; `< <= > >= !=`, `not in`, field `=` field are false on a null operand. Divergence: `not (…)` over a null comparison is TRUE here, UNKNOWN on SQL.                                                                                                                                                                                                                                                                                                      |
| 3   | Inner (default) → `$unwind` without `preserveNullAndEmptyArrays`; `'left'` → preserved, left-joined fields project as `null`. Only a source that may be missing (left join, optional field, leaf inside `@db.json`; mapping `nullable`) is wrapped in `$ifNull: [src, null]` — required sources stay plain paths so view `$match`/`$sort` push down.                                                                                                                                                                         |
| 4   | `matches` rejected in join conditions (`$regexMatch` = 4.2); still allowed in `@db.view.filter`. Filter / having go through the shared query translation (`translateQueryTree` → `buildMongoFilter`): `!=` also matches null/missing, `exists` = holds a value (`not exists` = null/missing), `matches` takes `/re/flags`, field-to-field → `$expr` AND-guarded so every field operand is non-null (all of `= != < <= > >=`; since 0.1.137 — ≤ 0.1.136 a missing operand compared below every value, `7 > missing` matched). |
| 5   | `@db.agg.count "field"` counts non-null, non-missing values; `$sum` over no values = `0` (SQL `NULL`). `@db.view.materialized` = plain view.                                                                                                                                                                                                                                                                                                                                                                                 |
| 6   | Revision `"2"` (0.1.137) → upgrading recreates each managed view once (`plan()` → `alter`, metadata-only) — [`viewRenderRevision()`](https://db.atscript.dev/adapters/creating-adapters#view-render-revision).                                                                                                                                                                                                                                                                                                               |

First-row joins + computed columns (0.1.147): a first-row join always uses the pipeline `$lookup` + `{ $sort: { <keys>, <pk>: 1 } }` + `{ $limit: 1 }` (BSON: null/missing sort first = SQL "NULL smallest"); computed columns = every field / literal leaf `$toDouble` (MongoDB 4.0+; int64 past 2^53 rounds like SQL), `$add` / `$subtract` / `$multiply`, `/` → `$cond` guard (`$divide` by 0 errors), unary `-` → `$multiply` by -1, `coalesce` → nested 2-arg `$ifNull`; grouped views evaluate them in an `$addFields` after `$group`, before HAVING. Revision stays `"2"`.

## Relational predicates (`$some` / `$none`, 0.1.147)

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A read whose filter holds a predicate runs as an AGGREGATION (find, findOne, count, findManyWithCount, grouped aggregate, text, vector, geo). Predicate-free reads unchanged (`find` / `countDocuments`).                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | Predicate-free top-level conditions `$match`ed BEFORE the `$lookup`s; each lookup `$limit: 1`. `count` with a predicate = aggregate `$count` (slower than `countDocuments`).                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | Search: predicate stages after the leading `$search` / `$text` / `$vectorSearch` (vector: after its own top-k). Geo: predicate-free part in `$geoNear.query`, predicates after it (exact).                                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | Writes (`updateMany`/`replaceMany`/`deleteMany`, scoped single-row writes): resolve matching `_id`s via the pipeline (streamed from the cursor, sorted by `_id` — never all ids in memory), then write by `_id $in` in batches of 1000 (predicate-free part re-checked; counts summed).                                                                                                                                                                                                                                                                                         |
| 5   | ATOMIC ONLY inside `withTransaction` (replica set). Without one: window between resolve and write — a related doc can change. The adapter never opens a tx itself; standalone Mongo = always non-atomic.                                                                                                                                                                                                                                                                                                                                                                        |
| 6   | NULL / missing FK (any part) never relates, also against target docs whose key is null / missing (separate `{ <key>: { $ne: null } }` `$match` after the join).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7   | Lookups (predicates AND `$with`) correlate with a BARE `$expr` `$eq` per key part (an `$and` of `$eq`s for composite keys) → index scan on MongoDB ≥ 5.0. Index the FK field on the `from` side, both junction FK fields, one compound index per composite key; `to` reads `_id` / unique `@meta.id`.                                                                                                                                                                                                                                                                           |
| 8   | `buildMongoFilter(filter)` throws `REL_FILTER_NOT_SUPPORTED` on a predicate — raw pipelines over translated filters: `mongoFilterStages(filter, { collation? })` or `buildMongoQuery(filter, { collation? })` → `{ pre?, lookups, match, temp }` + `planStages(plan)`. Run them WITHOUT a `collation`; `collation: (f) => adapter.fieldCollation(f)` renders the source's `'nocase'` fields. Temp fields: `__atscript_rf_<n>` (`$unset` by `planStages`).                                                                                                                       |
| 9   | COLLATION: a predicate pipeline never gets an operation-wide `collation` (it would govern join keys + related fields). Each table's `'nocase'` fields (source AND related) render explicitly: `$eq`/`$ne`/`$in`/`$nin` on strings → anchored, escaped `i` regex; join keys + binary fields byte-wise. String ranges on `'nocase'` and any string comparison on `'unicode'` → `REL_FILTER_NOT_SUPPORTED` (400) when the query has a predicate. `$sort` byte-wise there. Predicate writes compare like reads; plain (predicate-free) write filters pass no collation (byte-wise). |
| 10  | Sorted pages: `$sort`/`$skip`/`$limit` run AFTER the lookups — cost ∝ candidates surviving the predicate-free conditions, not page size; a sort index doesn't help. Narrow with predicate-free conditions.                                                                                                                                                                                                                                                                                                                                                                      |

## Known limits

- **`$exists` is not native key presence (since 0.1.132).** It means "holds a value" like SQL: `{ f: { $exists: true } }` → `{ f: { $ne: null } }`, `false` → `{ f: null }`, so a stored `null` counts as ABSENT. Filters that relied on null-valued keys matching `$exists: true` change results; key presence needs `adapter.collection`. → [queries.md § `$exists`](queries.md)
- **`@db.column` renames (fixed 0.1.132).** ≤ 0.1.131 reads (`findMany`/`findOne`/`findManyWithCount` + search/vector/geo) dropped a renamed field from `$select`ed rows and silently ignored it in `$sort`; dotted filters under a renamed parent and grouped queries (`$groupBy`, aggregate `$field`, `$sort`, `$having`) mapped wrongly. Now logical names work everywhere (memory had the same `$select`/`$sort` bug).
- **Nested-field `@db.column` is ignored (since 0.1.137).** Documents rename top-level keys only: `address.zip` with `@db.column 'zip_code'` is written, filtered, sorted, grouped, indexed and read by views at `address.zip` (SQL still flattens to `address__zip_code`); a renamed top-level object renames the first segment (`profile.bio` under `'prof'` → `prof.bio`). Nested `@db.column` / `@db.column.renamed` changes are no sync change. ≤ 0.1.136 reads addressed a bare `zip_code` (matched nothing); first sync after upgrade reports `address.zip` added / `zip_code` removed once.
- **Physical path = `documentPath` everywhere (since 0.1.137):** `fd.physicalName`, index fields, filters, patches, `$inc` / `$mul` for `profile.bio` under `@db.column 'prof'` → `prof.bio` (≤ 0.1.136: index on non-existent `profile.bio`, stray logical keys on `$inc` / merge `updateMany`). Upgrade: one-time snapshot diff (`prof.bio` added / `profile.bio` removed — harmless: unset hits nothing, backfill skips stored values) + index recreate.
- Referential actions (`@db.rel.onDelete 'cascade'` etc.) are application-level; concurrent writes can race.
- Managed full-text `text` indexes are mutually exclusive per collection — use Atlas Search for multi-index scenarios.
- `ensureTable()` is a no-op unless `@db.mongo.capped` is set (then `createCollection` with capped options).
