# annotations

Core `@db.*` annotations from `dbPlugin()` — portable across every adapter. Engine-specific namespaces (`@db.pg.*`, `@db.mysql.*`, `@db.mongo.*`) live in the per-engine references.

## Table & column

| Annotation                          | Target    | Args                                | Effect                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | --------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@db.table`                         | Interface | `name?: string`                     | Mark as table (defaults to interface name).                                                                                                                                                                                                                                                                                                           |
| `@db.table.renamed`                 | Interface | `oldName: string`                   | Previous table name — schema sync renames in place.                                                                                                                                                                                                                                                                                                   |
| `@db.table.preferredId.uniqueIndex` | Interface | `name?: string`                     | Pick a `@db.index.unique` group as the row's preferred identifier (UI/wire addressing). Defaults to PK when absent. Optional `name` matches the unique-index name; omitted → first declared. View interfaces rejected. See [actions.md § Preferred row identifier](actions.md#preferred-row-identifier).                                              |
| `@db.schema`                        | Interface | `name: string`                      | Database schema/namespace.                                                                                                                                                                                                                                                                                                                            |
| `@db.depth.limit`                   | Interface | `depth: number`                     | Security guard on nested writes (insert / replace / patch). Absent or `0` → server rejects nested payloads (HTTP 400). Unrelated to `/meta` shape.                                                                                                                                                                                                    |
| `@db.column`                        | Field     | `name: string`                      | Physical column name override. **Has perf cost — activates per-row key remapping for the whole table.** Do not use without a hard reason — see [§ `@db.column` — when to use it](#dbcolumn--when-to-use-it).                                                                                                                                          |
| `@db.column.renamed`                | Field     | `oldName: string`                   | Previous column name — schema sync renames.                                                                                                                                                                                                                                                                                                           |
| `@db.column.collate`                | Field     | `'binary' \| 'nocase' \| 'unicode'` | Portable collation.                                                                                                                                                                                                                                                                                                                                   |
| `@db.column.precision`              | Field     | `precision, scale`                  | Decimal precision (e.g. `DECIMAL(10,2)`).                                                                                                                                                                                                                                                                                                             |
| `@db.column.dimension`              | Field     | —                                   | Dimension — groupable in aggregate queries.                                                                                                                                                                                                                                                                                                           |
| `@db.column.measure`                | Field     | —                                   | Measure — aggregatable (numeric/decimal only).                                                                                                                                                                                                                                                                                                        |
| `@db.column.filterable`             | Field     | —                                   | Allow field in `/query` filters when the interface is gated `'manual'`. Adapter capability vetoes the `/meta` `filterable` flag — SQL adapters always report `false` on `@db.json` / array fields, Mongo reports `true`.                                                                                                                              |
| `@db.column.sortable`               | Field     | —                                   | Allow field in `$sort` when the interface is gated `'manual'`. Adapter capability vetoes the `/meta` `sortable` flag — JSON-stored fields are never sortable on any adapter (min/max-element sort is a footgun).                                                                                                                                      |
| `@db.table.filterable`              | Interface | `'auto' \| 'manual'`                | Filter gate. Absent or `'auto'` → every column filterable. `'manual'` → HTTP 400 for filters on fields without `@db.column.filterable`.                                                                                                                                                                                                               |
| `@db.table.sortable`                | Interface | `'auto' \| 'manual'`                | Sort gate. Same semantics for sort keys.                                                                                                                                                                                                                                                                                                              |
| `@db.json`                          | Field     | —                                   | Store as one JSON column instead of flattening. **Has perf cost — activates key remapping.**                                                                                                                                                                                                                                                          |
| `@db.ignore`                        | Field     | —                                   | Exclude from DB schema entirely.                                                                                                                                                                                                                                                                                                                      |
| `@db.http.path`                     | Interface | `path: string`                      | Hint for REST route. Overwritten at runtime with the controller's computed prefix (useful for FK value-help URLs).                                                                                                                                                                                                                                    |
| `@db.sync.method`                   | Interface | `'drop' \| 'recreate'`              | Structural-change strategy: `drop` loses data, `recreate` preserves via copy.                                                                                                                                                                                                                                                                         |
| `@db.patch.strategy`                | Field     | `'replace' \| 'merge'`              | Nested-object patch semantics. Default = replace = strict: required children must be supplied, optional children the user omits are null-filled at storage. `'merge'` is a local one-level opt-in (does not propagate; deeper objects revert to default unless they too carry the annotation). `@db.json` is always strict. See [patch.md](patch.md). |

## `@db.column` — when to use it

`@db.column` rebinds a `.as` field to a different physical column name. **It is not free.**
A single use anywhere in the interface flips that whole table onto the per-row key-translation
path — every read, write, filter, sort, projection, and patch op pays a `Map`-driven
rename pass per row, instead of handing the row to the driver verbatim. `@db.json` and
nested-object fields take the same path; mixing them with `@db.column` does not add a second
penalty, but the first one is enough to matter on hot reads.

**Default: do not use it.** Name your `.as` props the same as the physical column you want
and the adapter will skip the translation layer entirely.

Legitimate reasons (anything else is overhead for nothing):

1. The desired column name is a SQL reserved word that the dialect can't parameterize cleanly (`order`, `from`, `select`, `group`, `case`, …).
2. You're integrating with an existing schema you don't own (legacy DB, third-party tables, shared cross-language model).
3. Strict team convention enforces snake_case at the DB layer AND your TypeScript style enforces camelCase in apps. Pick this once and apply it whole-codebase — don't sprinkle remaps on individual fields.

Not legitimate (these come up often, all of them mean "remove the annotation"):

- "I think `userId` reads better than `user_id` in TypeScript" — pick one, commit to it on both sides.
- "I want to keep my `.as` clean of snake_case" — same problem; you've just spread the cost across every read instead.
- "I'm not sure what the column should be called yet" — pick whatever the field is named; rename later via `@db.column.renamed` (which is a one-shot migration directive, not a runtime remap).

`@db.table 'physical_name'` has no per-row cost but follows the same spirit — only override when the desired table name is reserved (`User` is fine; `Order` collides with `ORDER BY` on some dialects) or you're adopting an existing table.

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

## Quantity tagging (currency / unit)

Bind a numeric field to its dimension. Mutually exclusive within a pair (literal vs `.ref`). `db.currencyCode` primitive is `string` constrained to `^[A-Z0-9]{2,10}$`.

| Annotation                | Host                | Args                | Effect                                                                                                            |
| ------------------------- | ------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@db.amount.currency`     | `decimal`           | `code: string`      | Schema-wide literal currency. Validated `^[A-Z0-9]{2,10}$`. No runtime constraint.                                |
| `@db.amount.currency.ref` | `decimal`           | `fieldName: string` | Per-row currency lives in named sibling. Sibling must exist + resolve to `string` (preferably `db.currencyCode`). |
| `@db.unit`                | `decimal \| number` | `code: string`      | Schema-wide literal unit (`'kg'`, `'rpm'`, `'qps'`, …). Free-form, no shape check.                                |
| `@db.unit.ref`            | `decimal \| number` | `fieldName: string` | Per-row unit in named sibling. Sibling must be `string`.                                                          |

Runtime: `aggregate()` rejects `sum/avg/min/max` on a `.ref`-tagged field unless `$groupBy` includes the ref field (`COUNT(*)` exempt; literal forms impose nothing). `moost-db` `AsDbReadableController` auto-adds the ref sibling to `$select` when its tagged value is requested. Both `.ref` annotations feed one shared map (`TableMetadata.quantityRefByField`); descriptors keep separate `currencyCode` / `currencyRefField` / `unitCode` / `unitRefField`.

```atscript
@db.table 'orders'
interface Order {
    @meta.id @db.default.uuid
    id: string
    currency: db.currencyCode
    @db.amount.currency.ref 'currency'
    @db.column.measure
    amount: decimal
}
```

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

### Preferred row identifier (slug-keyed example)

```atscript
@db.table 'users'
@db.table.preferredId.uniqueIndex 'by_slug'
interface User {
    @meta.id @db.default.uuid
    id: string
    @db.index.unique 'by_slug'
    slug: string
    name: string
}
```

`meta.preferredId` ships `["slug"]` instead of `["id"]`; UI URLs, list keys, and action invocations route by `slug`. PK still works for action addressing (precedence: PK first), but the UI default is the slug.

## Array helpers for patches

`@expect.array.key` marks the key field used to match elements during `$upsert`/`$update`/`$remove` array ops. `@expect.array.uniqueItems` enforces set-semantics on `$insert`. Both come from `@atscript/typescript` (the core skill), but the DB patch layer depends on them.
