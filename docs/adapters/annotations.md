---
outline: deep
---

# Annotations Reference

<!--@include: ../_experimental-warning.md-->

Complete reference for all `@db.*` annotations available in `.as` files. Generic annotations are provided by `@atscript/db/plugin` via `dbPlugin()` and work with every adapter. Adapter-specific annotations (PostgreSQL, MySQL, MongoDB) require the corresponding adapter plugin.

## Annotations never travel across field refs

A field that references another interface's field (an FK like `authorId: User.id`, or a view/dict field) inherits the target's **value and presentation** annotations (`@meta.label`, `@expect.*`, UI hints, literal `@db.amount.currency`/`@db.unit` tags) — but **never** its structural `@db.*` annotations. All `@db.index.*`, `@db.column.*`, `@db.default.*`, `@db.rel.*`, `@db.search.*`, `@db.agg.*`, `@db.encrypted`, `@db.json`, `@db.ignore`, and adapter-specific field annotations describe the storage of the table that declares them and stay there.

The sibling-ref quantity bindings — `@db.amount.currency.ref` and `@db.unit.ref` — also stay: they name a field of the **declaring** interface, which the referring interface may not have. A view that mirrors a measure and its currency/unit column re-declares the one-line `.ref` binding on its own field.

Practically: declaring `@db.index.unique` on `User.id` never creates an index on tables that FK-ref it; if the referring table needs an index on its FK column, declare one on the FK field itself. This holds at any ref depth (including refs through an intermediate dict/view interface). `extends` is different — inherited props keep all their annotations, structural ones included, because the child table physically owns those columns.

## Tables & Columns

| Annotation              | Applies To | Arguments                              | Description                                                                                                                                                                             |
| ----------------------- | ---------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@db.table`             | Interface  | `name?` (string)                       | Mark as database table (defaults to interface name)                                                                                                                                     |
| `@db.table.renamed`     | Interface  | `oldName` (string)                     | Previous table name for [schema sync](../sync/what-gets-synced) migration                                                                                                               |
| `@db.schema`            | Interface  | `name` (string)                        | Assign to a database schema/namespace                                                                                                                                                   |
| `@db.space`             | Interface  | `name` (string)                        | Assign to a named `DbSpace` for multi-database apps — groups the [model manifest](../sync/model-manifest) and drives token-based controller binding                                     |
| `@db.depth.limit`       | Interface  | `depth` (number)                       | Security guard on nested writes. Default `0` rejects any nested insert / replace / patch with HTTP 400. Raise `N` to allow deep writes up to that depth. Does not affect `/meta` shape. |
| `@db.column`            | Field      | `name` (string)                        | Override the physical column name ([perf note](#db-column-perf))                                                                                                                        |
| `@db.column.renamed`    | Field      | `oldName` (string)                     | Previous column name for [schema sync](../sync/what-gets-synced) migration                                                                                                              |
| `@db.column.collate`    | Field      | `collation` (string)                   | Portable collation: `'binary'`, `'nocase'`, or `'unicode'`                                                                                                                              |
| `@db.column.precision`  | Field      | `precision` (number), `scale` (number) | Decimal precision/scale for DB storage (e.g., `DECIMAL(10,2)`)                                                                                                                          |
| `@db.column.dimension`  | Field      | —                                      | Mark as dimension field — groupable in [aggregate queries](../views/aggregations)                                                                                                       |
| `@db.column.measure`    | Field      | —                                      | Mark as measure field — aggregatable (sum, avg, count, min, max). Numeric/decimal only                                                                                                  |
| `@db.column.filterable` | Field      | —                                      | Allow this field in client-side filter clauses when the table is in `@db.table.filterable 'manual'` mode (see below)                                                                    |
| `@db.column.sortable`   | Field      | —                                      | Allow this field in client-side sort keys when the table is in `@db.table.sortable 'manual'` mode (see below)                                                                           |
| `@db.column.version`    | Field      | —                                      | Mark a non-optional `int` field as the row's OCC version. Auto-bumped on every write; combine with inline `$cas` for conflict detection. See [Optimistic Concurrency](/api/versioning)  |
| `@db.table.filterable`  | Interface  | `mode?` (`'auto'` \| `'manual'`)       | Filter-gating mode. `'auto'` (default) keeps all columns filterable; `'manual'` requires `@db.column.filterable` on each filterable field                                               |
| `@db.table.sortable`    | Interface  | `mode?` (`'auto'` \| `'manual'`)       | Sort-gating mode. `'auto'` (default) keeps all columns sortable; `'manual'` requires `@db.column.sortable` on each sortable field                                                       |
| `@db.json`              | Field      | —                                      | Store as a single JSON column instead of flattening                                                                                                                                     |
| `@db.ignore`            | Field      | —                                      | Exclude field from the database schema entirely                                                                                                                                         |
| `@db.column.searchable` | Field      | —                                      | Include a string field in the generic `$search` fallback (case-insensitive substring across annotated fields) when the adapter has no native search; native search wins when configured |
| `@db.writeOnly`         | Field      | —                                      | HTTP write-only seal: settable via insert/update/replace, never present in read responses (projections exclude it; filter/sort/groupBy rejected; `/meta` flags it `writeOnly` so forms render set-only inputs). Pair with `@db.encrypted` for sealed secrets |

```atscript
@db.table 'users'
@db.schema 'auth'
interface User {
  @db.column 'full_name'
  name: string

  @db.json
  preferences: Preferences

  @db.ignore
  computedField: string

  @db.column.collate 'nocase'
  username: string

  @db.column.precision 10, 2
  price: number
}
```

::: warning @db.column performance {#db-column-perf}
Only use `@db.column` when you have a genuine reason — such as mapping to a legacy schema or meeting an external naming convention you cannot change. When a table has no `@db.column`, nested objects, or `@db.json` fields, the read, filter, and patch paths take a zero-allocation fast path that skips key translation entirely. Adding even one `@db.column` activates per-row key remapping on every read, write, filter, and patch operation for that table. In high-throughput scenarios this overhead is measurable.

If you control the database schema, prefer naming your Atscript fields to match the desired column names directly. See [Custom Column Names](../api/tables#custom-column-names) for more details.
:::

## Query Gate

By default, every column on a `@db.table` is filterable and sortable — this preserves back-compat for tables where the author hasn't thought about the query surface. When a table should expose a **narrow** query surface (e.g., a customer-facing reports endpoint), opt into manual mode:

```atscript
@db.table 'users'
@db.table.filterable 'manual'
@db.table.sortable 'manual'
interface User {
  @meta.id
  id: number

  @db.column.filterable
  email: string

  @db.column.sortable
  createdAt: number.timestamp
}
```

Semantics:

- `@db.table.filterable 'manual'` makes the readable controller reject (HTTP 400) any filter clause that references a field without `@db.column.filterable`.
- `@db.table.sortable 'manual'` does the same for sort keys against `@db.column.sortable`.
- `@db.table.filterable 'auto'` / `@db.table.sortable 'auto'` are documentary no-ops — they match the default behaviour when the annotation is absent, but make the author's intent explicit.
- The two gates are independent: a table can opt into strict filtering while leaving sort open, or vice versa.
- Without the annotation, behaviour is unchanged from previous releases — all columns are filterable/sortable.

The `/meta` endpoint exposes a per-field capability hint in `fields[<path>]` so clients can show or hide query controls per column:

- **`filterable`** — in `'auto'` mode, `true` for every adapter-capable field; in `'manual'` mode, only fields carrying `@db.column.filterable`.
- **`sortable`** — in `'auto'` mode, `true` only for **index-backed** fields: those in an explicit `@db.index*`, **primary keys**, and **unique** fields. (A primary key or unique column is index-backed on every adapter — Mongo `_id`, SQL PK/unique constraints — so it is sortable without an explicit `@db.index`.) In `'manual'` mode, only fields carrying `@db.column.sortable`.

Both flags are additionally gated by adapter capability — `@db.json` and array columns are never sortable on SQL adapters regardless of mode (see the [moost-db gate mode](../http/crud)).

::: tip Auto-mode sort is open at the query layer
In `'auto'` mode there is no sort gate, so the server still _accepts_ a `$sort` on any adapter-capable column — `sortable: false` in `/meta` is an advertisement (steering UIs toward indexed sort keys), not an enforced restriction. Opt into `@db.table.sortable 'manual'` if you need sort keys rejected with HTTP 400.
:::

## HTTP

| Annotation      | Applies To | Arguments       | Description                                                                                                                           |
| --------------- | ---------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `@db.http.path` | Interface  | `path` (string) | HTTP endpoint path for this table. Used by UI for value-help on FK fields. Overwritten at runtime by the controller's computed prefix |

```atscript
@db.table 'authors'
@db.http.path '/authors'
interface Author {
  @meta.id
  id: number
  name: string
}
```

When a controller is registered without an explicit prefix, `@db.http.path` is used as the route. At runtime, the final computed prefix (including parent routes) is written back to `@db.http.path` on the type metadata, so FK references always carry the correct URL.

### Normalization contract

The value carried in `type.metadata["db.http.path"]` has distinct semantics for writers and readers:

- **Writers** (annotation at compile time): the value is an optional path hint. The controller's computed prefix takes precedence at runtime, so the annotation may be omitted or overridden by the mount point.
- **Readers** (UI / client code / custom consumers): the runtime value is always (a) prefixed with a leading `/`, (b) inclusive of the Moost `globalPrefix`, and (c) the final public URL — usable verbatim with `fetch()` or `new Client(url)`.

Example: an author writes `@db.http.path '/authors'`; a consumer reading `type.metadata["db.http.path"]` at runtime sees `/api/db/tables/authors` when the controller is mounted under `globalPrefix: '/api'` at `/db/tables/authors`.

## Depth Limit (security guard)

`@db.depth.limit N` is a **security guard** on nested-write payloads — a declared ceiling on how deep a client can send nested inserts, replaces, or patches through `@db.rel.from` relations. Payloads deeper than `N` are rejected at the server boundary with HTTP 400 before any database access. Default when the annotation is absent is `0`, meaning no nested writes are accepted at all; authors opt in explicitly to `N >= 1` when they want the server to accept deep writes.

This annotation affects **only write acceptance**. It does not change `/meta` serialization, read/query behaviour, or wire shape (see the separate note below).

```atscript
@db.table 'authors'
@db.depth.limit 2
interface Author {
  @meta.id
  id: number
  name: string

  @db.rel.from
  posts?: Post[]
}
```

::: danger BREAKING CHANGE
Tables **without** `@db.depth.limit` are now treated as `@db.depth.limit 0`: the server **rejects any nested-write payload** (HTTP 400) before reaching the database. Previously the server accepted arbitrary-depth nested writes via the implicit `nested-writer`. That implicit behaviour has been removed: tables that require nested writes must opt in explicitly with `@db.depth.limit N` for the appropriate `N`.
:::

::: info `/meta` FK ref shape is independent
`/meta` always ships FK fields as shallow refs (`{ id, metadata }`) regardless of `@db.depth.limit`. The target's `db.http.path` is carried in the ref metadata, so clients can resolve value-help URLs and fetch the target's own `/meta` on demand when they need deeper structure. Nav-prop trees (`@db.rel.from` / `@db.rel.to` / `@db.rel.via`) are fully expanded in meta regardless of this annotation, so the write-payload shape clients need is unaffected. (Prior releases shipped `refDepth: 1` and coupled meta expansion to `@db.depth.limit`; that coupling has been removed.)
:::

## Defaults

| Annotation              | Applies To | Arguments         | Description                                        |
| ----------------------- | ---------- | ----------------- | -------------------------------------------------- |
| `@db.default`           | Field      | `value` (string)  | Static default value                               |
| `@db.default.increment` | Field      | `start?` (number) | Auto-incrementing integer (requires number type)   |
| `@db.default.uuid`      | Field      | —                 | Random UUID string (requires string type)          |
| `@db.default.now`       | Field      | —                 | Current timestamp (requires number or string type) |

```atscript
@db.table
interface Product {
  @meta.id
  @db.default.uuid
  id: string

  @db.default 'untitled'
  name: string

  @db.default.now
  createdAt: number
}
```

## Indexes

| Annotation           | Applies To | Arguments                            | Description                                                |
| -------------------- | ---------- | ------------------------------------ | ---------------------------------------------------------- |
| `@db.index.plain`    | Field      | `name?` (string), `sort?` (string)   | Standard index, optional sort direction (`'asc'`/`'desc'`) |
| `@db.index.unique`   | Field      | `name?` (string)                     | Unique constraint index                                    |
| `@db.index.fulltext` | Field      | `name?` (string), `weight?` (number) | Full-text search index with optional weight                |

Use the same index name on multiple fields to create a composite index.

```atscript
@db.table
interface Article {
  @db.index.unique
  slug: string

  @db.index.plain 'date_idx', 'desc'
  publishedAt: number

  // Composite index across two fields
  @db.index.plain 'author_cat'
  authorId: string

  @db.index.plain 'author_cat'
  category: string

  @db.index.fulltext 'search', 3
  title: string

  @db.index.fulltext 'search', 1
  body: string
}
```

## Search

| Annotation                    | Applies To | Arguments                                                            | Description                                 |
| ----------------------------- | ---------- | -------------------------------------------------------------------- | ------------------------------------------- |
| `@db.search.vector`           | Field      | `dimensions` (number), `similarity?` (string), `indexName?` (string) | Vector search field                         |
| `@db.search.vector.threshold` | Field      | `value` (number)                                                     | Default minimum similarity threshold (0--1) |
| `@db.search.filter`           | Field      | `indexName` (string)                                                 | Pre-filter field for vector search          |

Similarity options: `'cosine'` (default), `'euclidean'`, `'dotProduct'`. Each adapter maps to its native vector type — see [Text Search](../search/) and [Vector Search](../search/vector-search).

Allowed `dimensions` values (whitelisted at compile time): `256`, `384`, `512`, `768`, `1024`, `1536`, `2048`, `3072`, `4096`, `6144`, `8192`, `16384`.

```atscript
@db.table
interface Document {
  @db.search.vector 1536, 'cosine', 'doc_vec'
  @db.search.vector.threshold 0.7
  embedding: db.vector

  @db.search.filter 'doc_vec'
  category: string
}
```

## Relations

| Annotation         | Applies To | Arguments          | Description                                                                             |
| ------------------ | ---------- | ------------------ | --------------------------------------------------------------------------------------- |
| `@db.rel.FK`       | Field      | `alias?` (string)  | [Foreign key](../relations/) (field must use chain ref). **Dual role** — see note below |
| `@db.rel.to`       | Field      | `alias?` (string)  | Forward [navigation](../relations/navigation) (N:1, FK on this table)                   |
| `@db.rel.from`     | Field      | `alias?` (string)  | Reverse [navigation](../relations/navigation) (1:N, FK on other table)                  |
| `@db.rel.via`      | Field      | `junction` (ref)   | Many-to-many [navigation](../relations/navigation) through a junction table             |
| `@db.rel.onDelete` | Field      | `action` (string)  | Referential action on parent delete                                                     |
| `@db.rel.onUpdate` | Field      | `action` (string)  | Referential action on parent update                                                     |
| `@db.rel.filter`   | Field      | `condition` (expr) | Static filter condition on navigation property                                          |

```atscript
@db.table
interface Task {
  @db.rel.FK
  @db.rel.onDelete 'cascade'
  projectId: Project.id

  @db.rel.to
  project: Project

  @db.rel.from
  comments: Comment[]

  @db.rel.via TaskTag
  tags: Tag[]

  @db.rel.from
  @db.rel.filter `status = 'open'`
  openSubtasks: Task[]
}
```

### `@db.rel.FK` dual role

`@db.rel.FK` serves two purposes depending on the host interface:

- On a `@db.table` interface it drives **DB-relation semantics** — the relation loader pairs it with `@db.rel.to` / `@db.rel.from`, it participates in `@db.rel.via` junction resolution, and the integrity layer validates it at write time.
- On any other interface (value-help dictionaries, WF forms, plain interfaces) it acts purely as the **value-help indicator**: the client-side picker resolver reads `@db.rel.FK` to decide which fields render a value-help picker, and the URL for the picker comes from the target's `@db.http.path`.

The host-restriction rule was relaxed so the same annotation covers both cases — authors don't need a separate marker for value-help. All other validation rules still apply (the target must be a chain reference to a `@meta.id` or `@db.index.unique` field).

### Referential Action Values

For `@db.rel.onDelete` and `@db.rel.onUpdate`:

| Action         | Description                                   |
| -------------- | --------------------------------------------- |
| `'cascade'`    | Propagate delete/update to related rows       |
| `'restrict'`   | Prevent operation if related rows exist       |
| `'noAction'`   | Database default behavior (no action)         |
| `'setNull'`    | Set FK to null (field must be optional)       |
| `'setDefault'` | Set FK to default value (needs `@db.default`) |

## Views

| Annotation              | Applies To | Arguments                          | Description                                                              |
| ----------------------- | ---------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `@db.view`              | Interface  | `name?` (string)                   | Mark as database [view](../views/) (defaults to interface name)          |
| `@db.view.for`          | Interface  | `entry` (ref)                      | Entry/primary table for a managed view                                   |
| `@db.view.joins`        | Interface  | `target` (ref), `condition` (expr) | Explicit join clause (repeatable)                                        |
| `@db.view.filter`       | Interface  | `condition` (expr)                 | View WHERE clause                                                        |
| `@db.view.having`       | Interface  | `condition` (expr)                 | Post-aggregation HAVING clause                                           |
| `@db.view.materialized` | Interface  | —                                  | Mark the view as materialized                                            |
| `@db.view.renamed`      | Interface  | `oldName` (string)                 | Previous view name for [schema sync](../sync/what-gets-synced) migration |

```atscript
@db.view
@db.view.for Task
@db.view.joins Project, `Project.id = Task.projectId`
@db.view.filter `Task.status = 'active'`
interface ActiveTaskView {
  taskName: Task.name
  projectName: Project.name
  dueDate: Task.dueDate
}
```

## Aggregation

| Annotation      | Applies To | Arguments         | Description                                                                 |
| --------------- | ---------- | ----------------- | --------------------------------------------------------------------------- |
| `@db.agg.sum`   | Field      | `field` (string)  | SUM of a source column (numeric/decimal only)                               |
| `@db.agg.avg`   | Field      | `field` (string)  | AVG of a source column (numeric/decimal only)                               |
| `@db.agg.count` | Field      | `field?` (string) | COUNT — omit argument for `COUNT(*)`, provide field name for non-null count |
| `@db.agg.min`   | Field      | `field` (string)  | MIN of a source column                                                      |
| `@db.agg.max`   | Field      | `field` (string)  | MAX of a source column                                                      |

Use aggregation annotations on [view](../views/aggregations) fields together with `@db.column.dimension` on grouping fields.

```atscript
@db.view
@db.view.for Order
@db.view.having `totalRevenue > 100`
interface CategoryStats {
  @db.column.dimension
  category: Order.category

  @db.agg.sum 'amount'
  totalRevenue: number

  @db.agg.count
  orderCount: number

  @db.agg.avg 'amount'
  avgOrderValue: number
}
```

## Quantity Tagging (currency & unit)

Bind a numeric field to its **dimension** (currency code, unit of measure) so the runtime can enforce correct aggregation grouping and the readable controller can guarantee the dimension is always shipped alongside the value.

| Annotation                | Applies To                | Arguments            | Description                                                                                                                                                                               |
| ------------------------- | ------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@db.amount.currency`     | Field (`decimal`)         | `code` (string)      | Hard-coded ISO-style currency code (`'EUR'`, `'USD'`, `'BTC'`). Validated against `^[A-Z0-9]{2,10}$`. Schema-wide constant — no runtime aggregation constraint. UI reads it from `/meta`. |
| `@db.amount.currency.ref` | Field (`decimal`)         | `fieldName` (string) | Bind this amount to a sibling field that holds the per-row currency code. Sibling must exist and resolve to a `string` (preferably `db.currencyCode`).                                    |
| `@db.unit`                | Field (`decimal\|number`) | `code` (string)      | Hard-coded unit of measure (`'kg'`, `'rpm'`, `'qps'`, `'requests/sec'`). Free-form string — no shape validation. Schema-wide constant.                                                    |
| `@db.unit.ref`            | Field (`decimal\|number`) | `fieldName` (string) | Bind this quantity to a sibling field holding the per-row unit. Sibling must exist and resolve to a `string`.                                                                             |

The two forms (literal vs `.ref`) are mutually exclusive on the same field. Money-bearing fields must be `decimal` — floats lose cents. Quantity fields accept both `decimal` (weights, lengths) and `number` (counts, rates).

### `db.currencyCode` primitive

Companion type for the `.ref` target — a `string` constrained to `^[A-Z0-9]{2,10}$` so non-currency strings can't be silently used as the dimension.

```atscript
@db.table 'orders'
interface Order {
  @meta.id @db.default.uuid
  id: string

  // Per-row currency: each line carries its own code.
  currency: db.currencyCode

  @db.amount.currency.ref 'currency'
  @db.column.measure
  amount: decimal
}

@db.table 'metrics'
interface Metric {
  @meta.id @db.default.uuid
  id: string

  // Single-currency table: literal form, no sibling field.
  @db.amount.currency 'EUR'
  @db.column.measure
  fee: decimal

  // Mixed-unit measurement: ref form.
  unit: string
  @db.unit.ref 'unit'
  @db.column.measure
  weight: decimal

  // Single-unit metric: literal form.
  @db.unit 'qps'
  @db.column.measure
  rate: number
}
```

### Runtime behavior

- **Aggregation guard.** When `aggregate()` is called against a field carrying `@db.amount.currency.ref` or `@db.unit.ref`, the referenced field MUST appear in `$groupBy`. Otherwise `DbError("INVALID_QUERY")`. Literal forms (`@db.amount.currency 'EUR'`, `@db.unit 'kg'`) impose no runtime constraint — the dimension is satisfied schema-wide. `COUNT(*)` is exempt.
- **`$select` auto-widening.** The `moost-db` readable controller automatically adds the referenced sibling to `$select` whenever its tagged value is requested. UI can ask for `$select=amount` and still receive `currency` in the response. Literal forms are NOT widened — the constant is on the field descriptor, not row data.
- **Field descriptors.** `TDbFieldMeta` exposes `currencyCode` / `currencyRefField` / `unitCode` / `unitRefField` so clients can format quantities correctly without inspecting raw annotations.

## Schema Sync

| Annotation        | Applies To | Arguments         | Description                             |
| ----------------- | ---------- | ----------------- | --------------------------------------- |
| `@db.sync.method` | Interface  | `method` (string) | Sync strategy: `'drop'` or `'recreate'` |

- **`'drop'`** — Drop and recreate the table on structural changes (lossy, data is deleted).
- **`'recreate'`** — Recreate with data preservation on structural changes.

## Patch Behavior

| Annotation           | Applies To | Arguments           | Description                        |
| -------------------- | ---------- | ------------------- | ---------------------------------- |
| `@db.patch.strategy` | Field      | `strategy` (string) | `'replace'` (default) or `'merge'` |

Controls how nested objects are handled during PATCH/update operations. With `'replace'`, the entire nested object is overwritten. With `'merge'`, individual sub-fields are deep-merged.

## PostgreSQL-Specific {#postgresql}

These annotations require the `@atscript/db-postgres` plugin. See [PostgreSQL adapter](./postgresql).

| Annotation       | Applies To        | Arguments            | Description                                                        |
| ---------------- | ----------------- | -------------------- | ------------------------------------------------------------------ |
| `@db.pg.type`    | Field             | `type` (string)      | Override native PG column type (e.g., `CITEXT`, `INET`, `MACADDR`) |
| `@db.pg.schema`  | Interface         | `schema` (string)    | PostgreSQL schema (default: `public`)                              |
| `@db.pg.collate` | Interface / Field | `collation` (string) | Native PG collation (overrides portable `@db.column.collate`)      |

```atscript
use '@atscript/db-postgres'

@db.table 'users'
@db.pg.schema 'auth'
interface User {
  @meta.id
  @db.default.uuid
  id: string

  @db.pg.type 'CITEXT'
  email: string

  @db.pg.collate 'tr-x-icu'
  name: string
}
```

## MySQL-Specific {#mysql}

These annotations require the `@atscript/db-mysql` plugin. See [MySQL adapter](./mysql).

| Annotation           | Applies To        | Arguments             | Description                                                        |
| -------------------- | ----------------- | --------------------- | ------------------------------------------------------------------ |
| `@db.mysql.engine`   | Interface         | `engine` (string)     | Storage engine (default: `InnoDB`)                                 |
| `@db.mysql.charset`  | Interface / Field | `charset` (string)    | Character set (default: `utf8mb4`)                                 |
| `@db.mysql.collate`  | Interface / Field | `collation` (string)  | Native MySQL collation (overrides portable `@db.column.collate`)   |
| `@db.mysql.unsigned` | Field             | —                     | UNSIGNED modifier for integer columns                              |
| `@db.mysql.type`     | Field             | `type` (string)       | Override native MySQL column type (e.g., `MEDIUMTEXT`, `TINYTEXT`) |
| `@db.mysql.onUpdate` | Field             | `expression` (string) | ON UPDATE expression (e.g., `CURRENT_TIMESTAMP`)                   |

```atscript
use '@atscript/db-mysql'

@db.table 'events'
@db.mysql.engine 'InnoDB'
@db.mysql.charset 'utf8mb4'
interface Event {
  @meta.id
  @db.default.increment
  id: number

  @db.mysql.type 'MEDIUMTEXT'
  description: string

  @db.mysql.unsigned
  viewCount: number

  @db.default.now
  @db.mysql.onUpdate 'CURRENT_TIMESTAMP'
  updatedAt: number
}
```

## MongoDB-Specific {#mongodb}

These annotations require the `@atscript/db-mongo` plugin. See [MongoDB adapter](./mongodb).

| Annotation                      | Applies To | Arguments                                                                                                                                      | Description                                                                                                                                       |
| ------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@db.mongo.collection`          | Interface  | —                                                                                                                                              | Mark as MongoDB collection (auto-injects `_id`)                                                                                                   |
| `@db.mongo.capped`              | Interface  | `size` (number), `max?` (number)                                                                                                               | Capped collection with max byte size and optional doc limit                                                                                       |
| `@db.mongo.search.dynamic`      | Interface  | `analyzer?` (string), `fuzzy?` (number)                                                                                                        | Dynamic Atlas Search index                                                                                                                        |
| `@db.mongo.search.static`       | Interface  | `analyzer?` (string), `fuzzy?` (number), `indexName?` (string), `strategy?` (string)                                                           | Named static Atlas Search index. `strategy`: `compound` (default) / `autocomplete` / `text`                                                       |
| `@db.mongo.search.text`         | Field      | `analyzer?` (string), `indexName?` (string)                                                                                                    | Include field in a search index (word match)                                                                                                      |
| `@db.mongo.search.autocomplete` | Field      | `indexName?` (string), `tokenization?` (string), `minGrams?` (number), `maxGrams?` (number), `foldDiacritics?` (boolean), `analyzer?` (string) | Prefix/typeahead field (double-mapped as `string`). `tokenization`: `edgeGram` (prefix, default) / `nGram` (substring) / `rightEdgeGram` (suffix) |

When `indexName` is omitted it defaults to `"DEFAULT"` — interface-level and field-level annotations referencing the same name are merged into one Atlas Search index. See [MongoDB adapter — Atlas Search](./mongodb#atlas-search).

```atscript
use '@atscript/db-mongo'

@db.table 'products'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 1, 'main_search'
interface Product {
  @meta.id
  _id: mongo.objectId

  @db.mongo.search.text 'lucene.english', 'main_search'
  name: string

  @db.search.vector 1536, 'cosine', 'vec_idx'
  embedding: number[]

  @db.search.filter 'vec_idx'
  category: string
}
```

::: info Generic search annotations
`@db.search.vector` and `@db.search.filter` are generic annotations (not MongoDB-specific) and work across all adapters that support vector search. See the [Search](#search) section above.
:::

## Related Annotations {#related}

These are not `@db.*` annotations but are commonly used alongside the database layer.

| Annotation                  | Applies To | Arguments | Description                                                      |
| --------------------------- | ---------- | --------- | ---------------------------------------------------------------- |
| `@meta.id`                  | Field      | —         | Mark as primary key field (multiple fields form a composite key) |
| `@expect.array.key`         | Field      | —         | Array element key field for patch matching                       |
| `@expect.array.uniqueItems` | Field      | —         | Enforce unique items in an array                                 |

```atscript
@db.table
interface OrderLine {
  // Composite primary key
  @meta.id
  orderId: Order.id

  @meta.id
  productId: Product.id

  quantity: number
}
```
