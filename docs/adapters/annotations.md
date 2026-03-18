---
outline: deep
---

# Annotations Reference

<!--@include: ../_experimental-warning.md-->

Complete reference for all `@db.*` annotations available in `.as` files. Generic annotations are provided by `@atscript/db/plugin` via `dbPlugin()` and work with every adapter. Adapter-specific annotations (PostgreSQL, MySQL, MongoDB) require the corresponding adapter plugin.

## Tables & Columns

| Annotation             | Applies To | Arguments                              | Description                                                                            |
| ---------------------- | ---------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| `@db.table`            | Interface  | `name?` (string)                       | Mark as database table (defaults to interface name)                                    |
| `@db.table.renamed`    | Interface  | `oldName` (string)                     | Previous table name for [schema sync](../sync/what-gets-synced) migration              |
| `@db.schema`           | Interface  | `name` (string)                        | Assign to a database schema/namespace                                                  |
| `@db.column`           | Field      | `name` (string)                        | Override the physical column name ([perf note](#db-column-perf))                       |
| `@db.column.renamed`   | Field      | `oldName` (string)                     | Previous column name for [schema sync](../sync/what-gets-synced) migration             |
| `@db.column.collate`   | Field      | `collation` (string)                   | Portable collation: `'binary'`, `'nocase'`, or `'unicode'`                             |
| `@db.column.precision` | Field      | `precision` (number), `scale` (number) | Decimal precision/scale for DB storage (e.g., `DECIMAL(10,2)`)                         |
| `@db.column.dimension` | Field      | —                                      | Mark as dimension field — groupable in [aggregate queries](../views/aggregations)      |
| `@db.column.measure`   | Field      | —                                      | Mark as measure field — aggregatable (sum, avg, count, min, max). Numeric/decimal only |
| `@db.json`             | Field      | —                                      | Store as a single JSON column instead of flattening                                    |
| `@db.ignore`           | Field      | —                                      | Exclude field from the database schema entirely                                        |

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

| Annotation         | Applies To | Arguments          | Description                                                                 |
| ------------------ | ---------- | ------------------ | --------------------------------------------------------------------------- |
| `@db.rel.FK`       | Field      | `alias?` (string)  | [Foreign key](../relations/) (field must use chain ref)                     |
| `@db.rel.to`       | Field      | `alias?` (string)  | Forward [navigation](../relations/navigation) (N:1, FK on this table)       |
| `@db.rel.from`     | Field      | `alias?` (string)  | Reverse [navigation](../relations/navigation) (1:N, FK on other table)      |
| `@db.rel.via`      | Field      | `junction` (ref)   | Many-to-many [navigation](../relations/navigation) through a junction table |
| `@db.rel.onDelete` | Field      | `action` (string)  | Referential action on parent delete                                         |
| `@db.rel.onUpdate` | Field      | `action` (string)  | Referential action on parent update                                         |
| `@db.rel.filter`   | Field      | `condition` (expr) | Static filter condition on navigation property                              |

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

| Annotation                 | Applies To | Arguments                                                      | Description                                                 |
| -------------------------- | ---------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| `@db.mongo.collection`     | Interface  | —                                                              | Mark as MongoDB collection (auto-injects `_id`)             |
| `@db.mongo.capped`         | Interface  | `size` (number), `max?` (number)                               | Capped collection with max byte size and optional doc limit |
| `@db.mongo.search.dynamic` | Interface  | `analyzer?` (string), `fuzzy?` (number)                        | Dynamic Atlas Search index                                  |
| `@db.mongo.search.static`  | Interface  | `analyzer?` (string), `fuzzy?` (number), `indexName?` (string) | Named static Atlas Search index                             |
| `@db.mongo.search.text`    | Field      | `analyzer?` (string), `indexName?` (string)                    | Include field in a search index                             |

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
