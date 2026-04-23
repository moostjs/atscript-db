# annotations

Core `@db.*` annotations from `dbPlugin()` — portable across every adapter. Engine-specific namespaces (`@db.pg.*`, `@db.mysql.*`, `@db.mongo.*`) live in the per-engine references.

## Table & column

| Annotation              | Target    | Args                                | Effect                                                                                                                                  |
| ----------------------- | --------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@db.table`             | Interface | `name?: string`                     | Mark as table (defaults to interface name).                                                                                             |
| `@db.table.renamed`     | Interface | `oldName: string`                   | Previous table name — schema sync renames in place.                                                                                     |
| `@db.schema`            | Interface | `name: string`                      | Database schema/namespace.                                                                                                              |
| `@db.deep.insert`       | Interface | `depth: number`                     | Max accepted nested-insert depth. Absent or `0` → server rejects nested payloads (HTTP 400); `/meta` ships `refDepth: N+0.5`.           |
| `@db.column`            | Field     | `name: string`                      | Physical column name override. **Has perf cost — activates per-row key remapping for the whole table.**                                 |
| `@db.column.renamed`    | Field     | `oldName: string`                   | Previous column name — schema sync renames.                                                                                             |
| `@db.column.collate`    | Field     | `'binary' \| 'nocase' \| 'unicode'` | Portable collation.                                                                                                                     |
| `@db.column.precision`  | Field     | `precision, scale`                  | Decimal precision (e.g. `DECIMAL(10,2)`).                                                                                               |
| `@db.column.dimension`  | Field     | —                                   | Dimension — groupable in aggregate queries.                                                                                             |
| `@db.column.measure`    | Field     | —                                   | Measure — aggregatable (numeric/decimal only).                                                                                          |
| `@db.column.filterable` | Field     | —                                   | Allow field in `/query` filters when the interface is gated `'manual'`.                                                                 |
| `@db.column.sortable`   | Field     | —                                   | Allow field in `$sort` when the interface is gated `'manual'`.                                                                          |
| `@db.table.filterable`  | Interface | `'auto' \| 'manual'`                | Filter gate. Absent or `'auto'` → every column filterable. `'manual'` → HTTP 400 for filters on fields without `@db.column.filterable`. |
| `@db.table.sortable`    | Interface | `'auto' \| 'manual'`                | Sort gate. Same semantics for sort keys.                                                                                                |
| `@db.json`              | Field     | —                                   | Store as one JSON column instead of flattening. **Has perf cost — activates key remapping.**                                            |
| `@db.ignore`            | Field     | —                                   | Exclude from DB schema entirely.                                                                                                        |
| `@db.http.path`         | Interface | `path: string`                      | Hint for REST route. Overwritten at runtime with the controller's computed prefix (useful for FK value-help URLs).                      |
| `@db.sync.method`       | Interface | `'drop' \| 'recreate'`              | Structural-change strategy: `drop` loses data, `recreate` preserves via copy.                                                           |
| `@db.patch.strategy`    | Field     | `'replace' \| 'merge'`              | Nested-object update behavior.                                                                                                          |

## Defaults

| Annotation              | Args             | Effect                                               |
| ----------------------- | ---------------- | ---------------------------------------------------- |
| `@db.default`           | `value: string`  | Static default (string form — parsed per adapter).   |
| `@db.default.increment` | `start?: number` | Auto-incrementing integer (requires numeric type).   |
| `@db.default.uuid`      | —                | Random UUID string.                                  |
| `@db.default.now`       | —                | Current timestamp (numeric timestamp or ISO string). |

## Indexes

| Annotation           | Args                                  | Effect                                                                                                |
| -------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `@db.index.plain`    | `name?: string, sort?: 'asc'\|'desc'` | Standard index. Share the same `name` across fields for composite.                                    |
| `@db.index.unique`   | `name?: string`                       | Unique constraint index.                                                                              |
| `@db.index.fulltext` | `name?: string, weight?: number`      | Full-text search index. Translates per-adapter: SQLite FTS5, PG tsvector, MySQL FULLTEXT, Mongo text. |

## Relations

| Annotation         | Target | Args                                                                 | Effect                                                                                                                                                       |
| ------------------ | ------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@db.rel.FK`       | Field  | `alias?: string`                                                     | Foreign key. Target field must be a chain ref to `@meta.id` or `@db.index.unique`. Dual role: on a non-`@db.table` host acts purely as value-help indicator. |
| `@db.rel.to`       | Field  | `alias?: string`                                                     | N:1 navigation (this table holds the FK).                                                                                                                    |
| `@db.rel.from`     | Field  | `alias?: string`                                                     | 1:N navigation (other table holds the FK).                                                                                                                   |
| `@db.rel.via`      | Field  | `junction: ref`                                                      | M:N navigation through a junction table.                                                                                                                     |
| `@db.rel.onDelete` | Field  | `'cascade' \| 'restrict' \| 'noAction' \| 'setNull' \| 'setDefault'` | Referential action on parent delete.                                                                                                                         |
| `@db.rel.onUpdate` | Field  | same                                                                 | Referential action on parent update.                                                                                                                         |
| `@db.rel.filter`   | Field  | `expr: query-expression`                                             | Static filter applied whenever the navigation is loaded.                                                                                                     |

## Views

| Annotation              | Target    | Args                           | Effect                                              |
| ----------------------- | --------- | ------------------------------ | --------------------------------------------------- |
| `@db.view`              | Interface | `name?: string`                | Mark as view (mutually exclusive with `@db.table`). |
| `@db.view.for`          | Interface | `entry: ref`                   | Primary (entry) table for a managed view.           |
| `@db.view.joins`        | Interface | `target: ref, condition: expr` | Repeatable JOIN clauses.                            |
| `@db.view.filter`       | Interface | `expr`                         | WHERE clause.                                       |
| `@db.view.having`       | Interface | `expr`                         | HAVING clause (post-aggregation).                   |
| `@db.view.materialized` | Interface | —                              | Materialize the view at DB level.                   |
| `@db.view.renamed`      | Interface | `oldName: string`              | Rename during sync.                                 |

## Aggregation (view fields only)

| Annotation      | Args             | Effect                       |
| --------------- | ---------------- | ---------------------------- |
| `@db.agg.sum`   | `field: string`  | SUM (numeric/decimal).       |
| `@db.agg.avg`   | `field: string`  | AVG.                         |
| `@db.agg.count` | `field?: string` | COUNT — omit for `COUNT(*)`. |
| `@db.agg.min`   | `field: string`  | MIN.                         |
| `@db.agg.max`   | `field: string`  | MAX.                         |

## Vector search (generic)

| Annotation                    | Args                                                          | Effect                                                                                   |
| ----------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `@db.search.vector`           | `dimensions: number, similarity?: string, indexName?: string` | Vector-indexed field. `similarity`: `'cosine'` (default), `'euclidean'`, `'dotProduct'`. |
| `@db.search.vector.threshold` | `value: number`                                               | Default min similarity (0–1).                                                            |
| `@db.search.filter`           | `indexName: string`                                           | Pre-filter field for a specific vector index.                                            |

## PK marker

`@meta.id` takes no arguments. Multiple `@meta.id` on different fields form a composite primary key. Never `@meta.id(...)`.

```atscript
@db.table 'order_lines'
interface OrderLine {
    @meta.id
    orderId: Order.id
    @meta.id
    productId: Product.id
    quantity: number
}
```

## Array helpers for patches

`@expect.array.key` marks the key field used to match elements during `$upsert`/`$update`/`$remove` array ops. `@expect.array.uniqueItems` enforces set-semantics on `$insert`. Both come from `@atscript/typescript` (the core skill), but the DB patch layer depends on them.
