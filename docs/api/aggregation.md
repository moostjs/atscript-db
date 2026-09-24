---
outline: deep
---

# Grouped Queries

<!--@include: ../_experimental-warning.md-->

`table.aggregate()` groups rows and computes counts, sums, averages, minimums and maximums at query time — the ad-hoc counterpart of [aggregation views](/views/aggregation-views), whose shape is fixed in the schema.

```typescript
const revenue = await orders.aggregate({
  filter: { status: "paid" },
  controls: {
    $groupBy: ["region"],
    $select: [
      "region",
      { $fn: "sum", $field: "amount", $as: "total" },
      { $fn: "count", $field: "*", $as: "orders" },
    ],
    $sort: { total: -1 },
  },
});
// [{ region: "US", total: 15420.5, orders: 87 }, { region: "EU", total: 8930, orders: 42 }]
```

The same query over HTTP is `GET /orders/query?status=paid&$groupBy=region&$select=region,sum(amount):total,count(*):orders&$sort=-total` — see [Aggregation in URLs](/http/advanced#groupby).

## The query

`aggregate()` takes an `AggregateQuery` — a `filter` plus required `controls`:

| Control             | Meaning                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$groupBy`          | **Required.** Field paths to group by, or the alias of a [calendar bucket](./calendar-buckets) declared in `$select`.                                                  |
| `$select`           | What each result row carries: plain fields (each must also appear in `$groupBy`), aggregate entries `{ $fn, $field, $as? }`, calendar-bucket entries `{ $bucket, … }`. |
| `$having`           | A filter on the groups — its keys must be aggregate aliases, bucket aliases or `$groupBy` fields.                                                                      |
| `$sort`             | Orders the groups by a grouped field or an alias.                                                                                                                      |
| `$skip` / `$limit`  | Pages over the groups.                                                                                                                                                 |
| `$count`            | Returns `[{ count: N }]` — the number of groups that survive `$having`.                                                                                                |
| `$search`, `$index` | Text search applied to the rows **before** grouping, so a rollup describes exactly the rows the same search lists.                                                     |

`$with` is not available on grouped queries.

## Aggregate functions

An aggregate entry is `{ $fn, $field, $as? }`. The semantics are the SQL ones on every adapter:

| `$fn`   | `$field`      | Result                                                                                    |
| ------- | ------------- | ----------------------------------------------------------------------------------------- |
| `count` | `'*'`         | Number of rows in the group                                                               |
| `count` | a field       | Number of rows where the field holds a value                                              |
| `sum`   | numeric field | Sum of the non-null values; `null` when there are none (MongoDB returns `0` in that case) |
| `avg`   | numeric field | Average of the non-null values; `null` when there are none                                |
| `min`   | any field     | Smallest non-null value                                                                   |
| `max`   | any field     | Largest non-null value                                                                    |

The output key is `$as` when given, otherwise `{fn}_{field}` — `sum_amount`, and `count_star` for `count(*)`. The HTTP parser uses the same rule, so `$select=count(*)` returns a `count_star` key too.

::: info `resolveAlias` and `count(*)` — 0.1.132
`resolveAlias` from `@atscript/db/agg` now returns `count_star` for `{ $fn: "count", $field: "*" }`. Up to 0.1.131 it returned `count_*`, which did not match the key the URL parser and the adapters produce.
:::

## Result rows

- **Each row carries what `$select` lists** — its plain fields, bucket aliases and aggregate aliases. Always pass a `$select`.
- **Grouped nested fields come back nested.** Grouping by a flattened nested-object leaf (`$groupBy: ['stats.views']`) returns `{ stats: { views: 1 }, cnt: 2 }` on every adapter, and grouped boolean, decimal and `@db.json` columns are coerced as in `findMany` (a grouped boolean is `true` / `false`, not `0` / `1`) — since 0.1.128.
- **`null` and missing form one group** on every adapter. Since 0.1.132 on MongoDB, which used to return a `null` group and a separate group for documents missing the field.
- **`$count`** counts the groups that survive `$having` (since 0.1.129).
- **Order** is whatever `$sort` asks for. Without `$sort`, no order is guaranteed.

## Dimensions and measures (strict mode)

When a table marks fields with [`@db.column.dimension` or `@db.column.measure`](/adapters/annotations#aggregation), grouped queries become strict:

- every `$groupBy` field must be a dimension, else `Field "x" is not a dimension` (path `$groupBy`). A [calendar bucket](./calendar-buckets#which-fields-can-be-bucketed)'s source field must be one too; that rule is reported on the field itself ([errors](./calendar-buckets#errors));
- every aggregate `$field` except `'*'` must be a measure, else `Aggregate field "x" is not a measure`.

A table without either annotation accepts any groupable field. Fields tagged with a currency or unit reference must also be grouped by that reference — see [Quantity dimensions](/views/aggregations#runtime-aggregation-quantity-dimensions).

## Validation and errors

Grouped queries are checked before any SQL or pipeline is built. Failures throw `DbError("INVALID_QUERY")` (HTTP 400 through moost-db):

| Mistake                                                                    | Message                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A plain `$select` field missing from `$groupBy`                            | `Plain field "x" in $select must also appear in $groupBy`                       |
| A `$having` key that is neither an alias nor a grouped field               | `$having key "x" must be an aggregate alias or a $groupBy field`                |
| A `$select` entry that is not a string, aggregate or bucket                | `Unsupported $select entry at index i`                                          |
| A `$groupBy` entry that is not a string                                    | `Unsupported $groupBy entry at index i — expected a field name or bucket alias` |
| A path that does not resolve to stored data (JSON descendant on SQL, etc.) | see [path validation](/api/queries#nested-field-filters)                        |

An `@db.encrypted` field in `$groupBy` or an aggregate fails with `ENC_FIELD_AGG`. Calendar buckets add their own rules — see [Calendar Buckets — Errors](./calendar-buckets#errors).

::: warning Malformed entries are rejected since 0.1.132
Up to 0.1.131 an unrecognized `$select` entry (for example `{ $fn: "sum" }` without `$field`) or a non-string `$groupBy` entry was silently dropped, so the query ran without it.
:::

## Adapter support

Grouped queries run on every adapter, with the semantics above.

- **Memory** — since 0.1.132 (earlier versions threw `INVALID_QUERY`). Groups are computed in process over one snapshot, in provider mode too. See [Memory — Grouped queries](/adapters/memory#grouped-queries).
- **MongoDB** — `@db.column`-renamed fields work in `$groupBy`, aggregate fields, `$sort` and `$having` since 0.1.132; earlier versions mapped them to the wrong document keys.

## See also

- [Calendar Buckets](./calendar-buckets) — group by day, week, month, quarter or year
- [Aggregation in URLs](/http/advanced#groupby) — `$groupBy`, `$having` and `fn(field):alias` over HTTP
- [HTTP Client — aggregate](/http/client#aggregate) — typed grouped queries from the browser
- [Aggregation Views](/views/aggregation-views) — aggregations declared in the schema
