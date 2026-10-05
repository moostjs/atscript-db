# queries

Filter/control shape is MongoDB-compatible; SQL adapters translate via `@atscript/db-sql-tools`.

## Uniquery shape

```ts
interface Uniquery<Own, Nav> {
  filter?: FilterExpr;
  controls?: UniqueryControls;
  insights?: UniqueryInsights; // optional; moost-db computes from URL
}
```

## Filter operators

All applied per-field unless inside `$and / $or / $not`. These ten are the whole set (`ComparisonOp` in `@uniqu/core`) — there is no `$like`, `$between`, `$contains` or `$startsWith`; use `$regex` for patterns and `$gte`+`$lte` for ranges. An unknown operator is rejected.

| Operator            | Example                                        | Meaning                                          |
| ------------------- | ---------------------------------------------- | ------------------------------------------------ |
| equality (implicit) | `{ name: 'Alice' }`                            | `=`                                              |
| `$eq`               | `{ id: { $eq: 1 } }`                           | `=`                                              |
| `$ne`               | `{ status: { $ne: 'done' } }`                  | `<>`                                             |
| `$gt / $gte`        | `{ age: { $gt: 18 } }`                         | `>` / `>=`                                       |
| `$lt / $lte`        | `{ age: { $lte: 65 } }`                        | `<` / `<=`                                       |
| `$in / $nin`        | `{ role: { $in: ['admin', 'editor'] } }`       | `IN` / `NOT IN`                                  |
| `$regex`            | `{ name: { $regex: /^al/i } }` (or `'/^al/i'`) | Regex, `string` fields (per-adapter translation) |
| `$exists`           | `{ deletedAt: { $exists: false } }`            | Holds a value (`null` ≡ absent) — below          |

## Logical composition

```ts
filter: {
  $and: [{ active: true }, { $or: [{ role: 'admin' }, { createdAt: { $gt: cutoff } }] }],
  $not: { email: { $endsWith: '@banned.dev' } },
}
```

## Null values (typing since 0.1.128)

Optional columns store SQL NULL / Mongo null, and the readable's flat / own-props generics are wrapped in `NullableOptional<O>` (`{ [K in keyof O]: undefined extends O[K] ? O[K] | null : O[K] }`), so these type-check and run:

```ts
await tasks.findMany({ filter: { note: null } }); // IS NULL
await tasks.findMany({ filter: { note: { $ne: null } } }); // IS NOT NULL
await tasks.updateOne({ id: 1, note: null }); // clears (omit the key to keep)
// { title: null } on a REQUIRED prop is a type error
```

`$in: [null]` never matches on SQL (`IN (NULL)`) — use the bare form. Optional columns read back as `null` (SQL) or absent (Mongo): compare with `== null`. `NullableOptional` is exported from `@atscript/db`.

## Value types (since 0.1.147)

Every comparison value (bare, `$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`, each `$in`/`$nin` element) must be able to stand for the field's declared type — else `DbError("INVALID_QUERY", [{ path: <field>, message: 'Invalid filter value for "n" ($gte): expected a number, got "abc"' }])` → HTTP 400, before any adapter call. ≤ 0.1.146: PostgreSQL 500, MySQL wrong rows (`'x'` → `0`), others `[]`.

| Field type                                                                                                          | Accepted                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `number`                                                                                                            | number, bigint, decimal-literal string (`"5"`, `"1e3"`; not `"0x10"`)                                                       |
| integer: `number.int*`, `number.timestamp`, `number` + `@db.default.increment`/`.now`, view `@db.agg.count*` column | integral number, bigint, integer string. `5.5` → 400 (PG int/bigint can't parse it). Timestamp = epoch ms; ISO string → 400 |
| `decimal`                                                                                                           | number, numeric string (`"12.50"`)                                                                                          |
| `boolean`                                                                                                           | `true` / `false`, `0` / `1` (`"true"` → 400)                                                                                |
| `string` / `string.*` / string literals                                                                             | string, number, boolean (URL `?code=123` is a number)                                                                       |
| union                                                                                                               | any member accepts                                                                                                          |
| array field (Mongo / memory)                                                                                        | element type; array operand → every element                                                                                 |
| `@db.json` + contents, object parents, `db.geoPoint`                                                                | never checked                                                                                                               |

`NaN` / `Infinity` / `-Infinity` (bare or in `$in`/`$nin`) on `number` / `decimal` → 400 `expected a number, got NaN` (since 0.1.148; integer fields always refused them). Always ok: `null` / `undefined`, class instances (`Date`, `ObjectId`). Literal unions checked by primitive type, not membership. `$regex` / bare `RegExp` → field must hold strings + pattern string/RegExp. Covers views (aggregate + `@db.compute` columns by declared type), `$having` (agg aliases number; `min`/`max` = source type; bucket alias string), `$some`/`$none` operands (path `issues.n`), `updateMany`/`deleteMany`. Runs after the path guard (unknown / unfilterable field keeps its error). Accepted values pass UNCHANGED — `"5"` on a number matches on SQL, not on Mongo / memory (strict types).

## `$exists` (since 0.1.132)

| #   | Rule                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Means "holds a value" on EVERY adapter: missing and explicit `null` → absent; `{}`, `[]`, `""`, `0`, `false` → present. `true` ≡ `$ne: null`, `false` ≡ `$eq: null`.                                                            |
| 2   | Mongo/memory CHANGED: a stored `null` used to count as present (key presence). Mongo now sends `{ f: { $ne: null } }` / `{ f: null }`. "Key present but null" is not expressible portably — use `adapter.collection`.           |
| 3   | Operand must be boolean — `1` / `"false"` → `INVALID_QUERY` (`$exists on "x" expects true or false`). Encrypted field → `ENC_FIELD_FILTER` first.                                                                               |
| 4   | Accepted on any stored, non-encrypted column, incl. `@db.json` objects / arrays on SQL (`IS [NOT] NULL`) — only when `$exists` is the entry's SOLE operator. `{ f: { $exists: true, $ne: null } }` on a JSON column → rejected. |
| 5   | Judged per occurrence in `$and` / `$or` / `$not` — an `$exists` entry never unlocks another entry on the same path.                                                                                                             |
| 6   | Still rejected: JSON descendants on SQL (`metrics.value`), flattened parents (`contact`), nav paths. `$sort` / `$groupBy` / `$having` / aggregate positions unchanged.                                                          |

## Path guard (since 0.1.128)

Every filter key, `$sort` key, `$select` entry, `$groupBy` field, `$having` key (minus aggregate aliases) and aggregate `$field` must resolve to physical storage on the adapter in use — checked in `guardPaths` before translation, for reads, `aggregate()`, `updateMany()` and `deleteMany()`. Otherwise `DbError("INVALID_QUERY", [{ path, message }])`:

| Path                                       | Result                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| physical column name (`contact__email`)    | `Unknown field` — logical paths only (breaking for overlays that used them)        |
| JSON / array descendant (`prefs.theme`)    | SQL adapters: rejected (`… inside JSON-stored column "prefs"`); Mongo/memory ok    |
| filter on JSON / array column (`prefs`)    | SQL: only a sole-`$exists` entry; else `… (accepted operators: $exists)`           |
| navigation path (`assignee.name`)          | rejected — filter with `{ assignee: { $some: … } }` (§ below) or load with `$with` |
| flattened parent (`contact`)               | `$select` ok (expands); filter / sort rejected — use a leaf                        |
| `$sort` on JSON / array column             | rejected on every adapter (`canSortField`)                                         |
| encrypted descendant in `$select`          | rejected — select the encrypted parent                                             |
| filter node key other than `$and/$or/$not` | `Unsupported filter operator "$nor" — use $and, $or or $not`                       |

`ENC_FIELD_*` / geo guards still fire first for encrypted subtrees and `$geoWithin`.

## Relational predicates — `$some` / `$none` (0.1.147)

Filter rows by their RELATED rows: operator map on a nav field (`@db.rel.to/.from/.via`).

```ts
await issues.findMany({
  filter: { ticket: { $some: { status: "open", teamId: { $in: teams } } } },
});
await tickets.findMany({ filter: { issues: { $none: {} } } }); // has no issues
await issues.findMany({ filter: { ticket: { $some: { team: { $some: { name: "Core" } } } } } }); // 2 hops
await tickets.updateMany({ labels: { $some: { name: "stale" } } }, { status: "closed" }); // mutation filter
```

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Related rows = EXACTLY what `$with=nav` loads (same FK pairing/alias, `@db.rel.filter` included). Same meaning for to/from/via. `$some: {}` = has any; `$none: {}` = has none. Several ops on one key ANDed.                                                                                                                                                                                                                                                                                                                              |
| 2   | NULL FK (any composite part) ⇒ no related row: `$some` false, `$none` TRUE — `{ ticket: { $none: F } }` includes ticket-less rows; add `ticketKey: { $ne: null }` to exclude. Identical on every adapter.                                                                                                                                                                                                                                                                                                                                 |
| 3   | Operand keys = the RELATED table's logical paths (`status`, never `ticket.status`); its field rules apply (unknown, `ENC_FIELD_FILTER`, SQL JSON descendants), error paths prefixed (`ticket.note`).                                                                                                                                                                                                                                                                                                                                      |
| 4   | One relation per level — nest predicates. Dotted nav keys stay `INVALID_QUERY` (`… use { ticket: { $some: { status: … } } }`). Mixing with comparison ops on one key → `INVALID_QUERY`; operand must be an object.                                                                                                                                                                                                                                                                                                                        |
| 5   | No `$every`: write `{ nav: { $none: { $not: F } } }` (vacuously true; add `$some: {}` to require one). NULLs inside `$not` differ (SQL unknown vs Mongo/memory mismatch) — spell the failing case out: `$none: { $or: [{ s: { $ne: "x" } }, { s: null }] }`.                                                                                                                                                                                                                                                                              |
| 6   | Accepted in: filters of find/findOne/count/findManyWithCount/search/vector/geo/`aggregate()` (row filter, NEVER `$having`), `$with` sub-filters, `updateMany`/`replaceMany`/`deleteMany`, row `scope`s. Server-side code needs no opt-in (HTTP: `@db.rel.filterable` → [moost-db.md](moost-db.md)).                                                                                                                                                                                                                                       |
| 7   | Core limits (every predicate, server-added included): depth 4 (`REL_FILTER_MAX_DEPTH`), 16 per filter incl. nested (`REL_FILTER_MAX_NODES`) → `INVALID_QUERY` with NO path. HTTP clients get 3 / 8 (`REL_FILTER_CLIENT_MAX_DEPTH` / `_NODES` from `@atscript/moost-db`, client predicates only) → headroom for server overlays. Self-referencing M:N junction → `INVALID_QUERY`. Related table in another database / connection (`adapter.sharesStoreWith`) → `REL_FILTER_NOT_SUPPORTED`. Messages name relations, never physical tables. |
| 8   | `REL_FILTER_NOT_SUPPORTED` (HTTP 400): adapter's `supportsRelationFilters(mode)` false (custom adapters by default), related table on another adapter class, table not built through a `DbSpace`.                                                                                                                                                                                                                                                                                                                                         |
| 9   | `$with` filter narrows CHILDREN; a predicate narrows PARENTS — independent, combine both for "matching parents with matching children".                                                                                                                                                                                                                                                                                                                                                                                                   |
| 10  | Cost: one correlated lookup per candidate row. Index the FK column on the `from` side and both junction FK columns (PG/SQLite/Mongo don't do it for you; MySQL InnoDB does).                                                                                                                                                                                                                                                                                                                                                              |
| 11  | Typing: nav keys accept `{ $some?, $none? }`, own fields reject `$some`; operand of an `.as` nav target is untyped (`Record<string, unknown>`).                                                                                                                                                                                                                                                                                                                                                                                           |

Per-adapter execution: SQL `EXISTS` (MySQL 1093 rewrite → [adapters-mysql.md](adapters-mysql.md)), Mongo aggregate + `$lookup` ([adapters-mongo.md](adapters-mongo.md)), memory key sets ([adapters-memory.md](adapters-memory.md)). URL form → [http-query-syntax.md](http-query-syntax.md).

## Controls

| Control               | Value                                              | Effect                                                                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$select`             | `string[] \| { [path]: 0 \| 1 }`                   | Projection. Array form = include-list; map form = explicit. Computed entries (aggregates, buckets) only with `$groupBy`; any other non-string entry → `INVALID_QUERY` `Unsupported $select entry at index i` (since 0.1.132; was silently dropped).                                                         |
| `$sort`               | `{ [path]: 1 \| -1 }`                              | Ordered keys.                                                                                                                                                                                                                                                                                               |
| `$skip`               | `number`                                           | Offset.                                                                                                                                                                                                                                                                                                     |
| `$limit`              | `number`                                           | Row cap.                                                                                                                                                                                                                                                                                                    |
| `$page` / `$size`     | `number`                                           | Used by `/pages` endpoint — alternative to `$skip`/`$limit`.                                                                                                                                                                                                                                                |
| `$count`              | `true`                                             | Return a count instead of rows. With `$groupBy` it is the number of groups surviving `$having` (since 0.1.129; earlier SQL ignored `$having` here and Mongo returned `0` for alias-based `$having`).                                                                                                        |
| `$with`               | `Array<{ name: string; filter?; controls?: ... }>` | Load nav relations. Nested `controls` apply per-relation, and `$sort` / `$skip` / `$limit` page EACH parent row's related rows (0.1.147, every adapter → [relations.md](relations.md#loading--controlswith)); `filter` narrows the loaded rows (may hold `$some`/`$none` on the related table's relations). |
| `$groupBy`            | `string[]`                                         | `aggregate()` only → [aggregation.md](aggregation.md).                                                                                                                                                                                                                                                      |
| `$having`             | `FilterExpr`                                       | Post-aggregation filter on aliases and `$groupBy` fields ONLY → [aggregation.md](aggregation.md).                                                                                                                                                                                                           |
| `$search` / `$vector` | `string` / `number[]`                              | Full-text / vector search (adapter must support).                                                                                                                                                                                                                                                           |
| `$actions`            | `boolean`                                          | `moost-db` HTTP only. When `true`, server attaches `$actions: string[]` to each returned row — `'row'`/`'rows'`-level action names NOT disabled. NOT widened on `$count`/`$groupBy`. See [actions.md](actions.md#actionstrue--server-evaluated-row-availability).                                           |

## Projection with $with

Response type is computed statically from `$with` — nav props absent unless requested.

```ts
const r = await posts.findMany({
  controls: { $with: [{ name: "author", controls: { $select: ["id", "name"] } }] },
});
r[0].author?.id; // typed
r[0].content; // still there — only nav props are stripped/added
```

## Aggregation

Grouped reads go through `table.aggregate()` — controls, SQL semantics, `count_star`, strict mode, `$search` before grouping → [aggregation.md](aggregation.md). Calendar buckets (hour/day/week/month in a time zone) → [calendar-buckets.md](calendar-buckets.md).

## Insights

`UniqueryInsights = Map<field, Set<InsightOp>>` — per-field operator set. Adapters use it for query-time behaviour (collation, tokenizer). `moost-db` computes it from the URL automatically; set manually only when building queries from non-URL sources.

## URL parsing

For HTTP consumption see `http-query-syntax.md` — the URL encoding differs (uses `field=v`, `field!=v`, `field>v`, etc.) and is parsed into the same `Uniquery` shape before reaching the adapter.

## moost-db read-response baseline

Direct adapter calls (`AtscriptDbTable.findOne`/`findMany`) honor `$select` exactly. The `moost-db` HTTP layer adds one extra step: every row-returning read endpoint (`/query`, `/pages`, `/one`, `/one/:id`, including `$search` and vector-search paths) silently widens `$select` to include the table's `preferredId` field set. Aggregate (`$groupBy`) and count (`$count`) responses are NOT widened. See [moost-db.md § Read-response baseline](moost-db.md#read-response-baseline) for the full contract — this is a controller behaviour, not a query-engine behaviour.
