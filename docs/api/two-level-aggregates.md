---
outline: deep
---

# Two-Level Aggregates

<!--@include: ../_experimental-warning.md-->

A two-level aggregate aggregates the rows of another grouped query. `controls.$from` is the **inner level**: a [grouped query](./aggregation) over the filtered table rows. The root controls are the **outer level**: they group and aggregate the inner rows. Use it when one number per entity has to be computed before it is summarized — "average spend per customer", "how many customers placed 1, 2, 3 … orders", "sum each order once, then total per region" (since 0.1.168).

```typescript
const spend = await orders.aggregate({
  filter: { status: "paid" },
  controls: {
    $from: {
      $groupBy: ["region", "customerId"],
      $select: [
        { $fn: "sum", $field: "amount", $as: "spent" },
        { $fn: "count", $field: "*", $as: "orders" },
      ],
    },
    $groupBy: ["region"],
    $select: [
      "region",
      { $fn: "count", $field: "*", $as: "customers" },
      { $fn: "avg", $field: "spent", $as: "avgSpent" },
      { $fn: "count", $field: "*", $where: { orders: { $gt: 1 } }, $as: "returning" },
    ],
    $sort: { avgSpent: -1 },
  },
});
// [{ region: "EU", customers: 42, avgSpent: 212.4, returning: 17 }, …]
```

Over HTTP: `GET /orders/query?status=paid&$from=($groupBy=region,customerId&$select=sum(amount):spent,count(*):orders)&$groupBy=region&$select=region,count(*):customers,avg(spent):avgSpent,count(*|orders>1):returning&$sort=-avgSpent` — see [Aggregation in URLs](/http/advanced#from).

## The two levels

| Level            | Controls                                                                                      | Reads                                                              |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Inner (`$from`)  | `$groupBy` (required, non-empty), `$select`, `$having`, `$rowOrder`, `$nulls`                 | The table rows the query `filter` (and `$search`) matches          |
| Outer (the root) | `$groupBy`, `$select`, `$having`, `$sort`, `$nulls`, `$rowOrder`, `$skip`, `$limit`, `$count` | The inner rows — their **columns**, never the table's other fields |

The **inner columns** are every inner `$groupBy` key (selected or not) and every computed alias of the inner `$select`. The outer level names only those: an outer `$groupBy` entry, a plain outer `$select` entry, an aggregate `$field`, a bucket source, an expression operand, a `$where` key and a `$rowOrder` key are all inner columns. `$having` and `$sort` name the outer result — outer `$groupBy` keys and outer aliases.

- The outer level may **group by an inner alias** (`$groupBy: ["orders"]` → customers per order count) and **bucket an inner timestamp column** — a timestamp `$groupBy` key, or the `min` / `max` / `first` / `last` of a timestamp field (`{ $bucket: "month", $field: "lastOrderAt", $as: "month" }`).
- Without an outer `$groupBy` (or with `[]`) every inner row is aggregated into one row, like an [ungrouped query](./aggregation#ungrouped).
- Both levels take every entry kind of a grouped query: [field lists](./aggregation#distinct-combinations), [conditions](./aggregation#conditional-aggregates), [arithmetic](./aggregation#arithmetic-expressions), [`first` / `last`](./aggregation#representative-row-first-last), [calendar buckets](./calendar-buckets). Outer `first` / `last` order the inner rows by the outer `$rowOrder`, ties broken by the inner `$groupBy` columns.
- Depth is fixed at two: a `$from` has no `$from` of its own. `$with` is not available.

## Rules

The inner level is checked exactly like a standalone grouped query — field visibility and capabilities, `@db.writeOnly`, encryption, [strict dimensions / measures](./aggregation#dimensions-and-measures-strict-mode), quantity references. Then both levels are resolved, and the outer level must read inner columns only. Strict mode does not apply to the outer level: its columns are inner results, not table fields. Over HTTP, an outer condition or order on an inner `$groupBy` field still meets that field's [filter / sort policy](/http/permissions#aggregates).

| Mistake                                                                         | Error (`INVALID_QUERY`, entry `code`)                 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| A `$from` inside `$from`                                                        | `AGG_NESTED_DEPTH`                                    |
| A control that is not valid at its level, or a `$from` that is not an object    | `AGG_NESTED_CONTROL`                                  |
| An inner level without `$groupBy`                                               | `AGG_NESTED_UNGROUPED`                                |
| Two inner (or outer result) columns with one name                               | `AGG_NESTED_DUPLICATE_COLUMN`                         |
| An outer name that is not an inner column — a table field included              | `AGG_NESTED_UNKNOWN_COLUMN`                           |
| An outer `sum` / `avg` / expression / bucket over a column that holds no number | `AGG_NESTED_NOT_NUMERIC`                              |
| An outer bucket over an inner column that holds no timestamp                    | `Cannot bucket "x" — not a timestamp column of $from` |

`$from` anywhere but an aggregate query — `findMany`, `count`, `/pages`, a `$with` relation, a [query target](/http/query-targets) — is rejected, never ignored. An adapter without two-level aggregates answers `AGG_NESTED_NOT_SUPPORTED` (HTTP 400); [`/meta.nestedAggregates`](/http/crud#get-meta) says whether an endpoint takes them.

## DOs and DON'Ts

- **Do** group the inner level by the entity you want counted or summed once (`customerId`, `orderId`), then summarize at the outer level.
- **Do** put row conditions in the query `filter` and filter inner groups with the inner `$having` — the inner level has no filter, `$sort` or `$limit` of its own, and the outer level reads inner columns only, never table fields.

## Adapter support

Every bundled adapter runs two-level aggregates — SQLite, PostgreSQL, MySQL, MongoDB (which may spill a large inner level to disk) and memory. A [custom adapter](/adapters/creating-adapters#nested-aggregates) opts in.

## See also

- [Grouped Queries](./aggregation) — the single level, field lists and conditions
- [Aggregation in URLs](/http/advanced#from) — the `$from=( … )` URL form
- [Permissions](/http/permissions#aggregates) — gating `$from` and conditions in a permission layer
- [HTTP Client — aggregate](/http/client#aggregate) — typed two-level queries
