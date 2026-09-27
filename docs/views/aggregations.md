---
outline: deep
---

# Aggregation Annotations

<!--@include: ../_experimental-warning.md-->

Aggregations compute values like sums, averages, and counts across groups of rows. In Atscript, you declare aggregations directly on view fields using `@db.agg.*` annotations — the database handles the computation.

## Available Functions

### `@db.agg.sum`

Computes the SUM of a numeric source column:

```atscript
@db.agg.sum "amount"
totalAmount: number
```

The field argument is the **source column name** from the entry table. The annotated field must be `number` or `decimal`.

### `@db.agg.avg`

Computes the AVG (average) of a numeric source column:

```atscript
@db.agg.avg "amount"
averageAmount: number
```

Like `sum`, the field must be `number` or `decimal`.

### `@db.agg.count`

Counts rows. Without an argument, it produces `COUNT(*)` — counting all rows. With a field name, it produces `COUNT(field)` — counting non-null values only:

```atscript
@db.agg.count
totalOrders: number        // COUNT(*)

@db.agg.count "assigneeId"
assignedOrders: number     // COUNT(assigneeId) — excludes nulls
```

The annotated field must be `number`.

::: tip
`COUNT(*)` counts all rows in each group, including those with null values. `COUNT(field)` only counts rows where the specified field is not null.
:::

### `@db.agg.min`

Minimum value of a source column:

```atscript
@db.agg.min "amount"
smallestOrder: number
```

Accepts any comparable type — numbers, strings, dates.

### `@db.agg.max`

Maximum value of a source column:

```atscript
@db.agg.max "createdAt"
latestOrder: number.timestamp
```

Accepts any comparable type. Annotate the result field with the source column's primitive (here `number.timestamp`) so the view's TypeScript output preserves type fidelity.

### `@db.agg.countDistinct`

Counts the **distinct non-null** values of a source column — `COUNT(DISTINCT field)` (since 0.1.136):

```atscript
@db.agg.countDistinct "customerId"
buyers: number             // COUNT(DISTINCT customerId)
```

The field argument is required (`'*'` is rejected) and the annotated field must be `number`. Nulls are never counted, and a group whose values are all null counts `0`.

::: warning Distinctness follows the column's collation
MySQL's default `*_ci` collations compare case-insensitively, so `'A'` and `'a'` count once there. PostgreSQL, SQLite and MongoDB compare case-sensitively and count them twice. On MongoDB the distinct values of each group are collected in memory (`$addToSet`), so a very high-cardinality column per group can hit the 100 MB `$group` limit.
:::

## Conditional Aggregates

Every `@db.agg.*` takes an optional second argument: a query that selects the rows the aggregate reads (since 0.1.136). Rows that don't match are skipped by that aggregate only. The group itself, and the other aggregates in it, still see every row.

```atscript
@db.view 'city_sales'
@db.view.for Order
@db.view.joins Customer, `Customer.id = Order.customerId`
export interface CitySales {
    city: Order.city

    @db.agg.count
    orders: number                                   // every order

    @db.agg.count '*', `status = 'paid'`
    paidOrders: number                               // COUNT(CASE WHEN … THEN 1 END)

    @db.agg.sum "amount", `status = 'paid'`
    paidRevenue: number                              // COALESCE(SUM(CASE WHEN … THEN amount END), 0)

    @db.agg.avg "amount", `status = 'paid'`
    paidAverage?: number                             // NULL when no paid order

    @db.agg.countDistinct "customerId", `Customer.vip = true`
    vipBuyers: number
}
```

On SQL, each one becomes `FN(CASE WHEN <condition> THEN <field> END)`. On MongoDB the `$group` accumulator reads `{ $cond: [<condition>, <field>, null] }`. Both follow the same NULL rules, so the results are the same.

| Rule                                                                                                                  | Why                                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A conditional **COUNT(\*)** is written `@db.agg.count '*', <condition>`. `'*'` is accepted by `count` only.           | The condition is the second argument, so the first must be spelled out.                         |
| A conditional **sum** is `0` when no row in the group matches, not `NULL`.                                            | "Revenue from paid orders" is 0 for a city without paid orders. MongoDB's `$sum` answers 0 too. |
| A conditional **avg / min / max** is `NULL` when no row matches, so its field **must be optional** (`paidAverage?:`). | Compile-time error otherwise.                                                                   |
| A conditional **count / countDistinct** is `0` when no row matches.                                                   | —                                                                                               |
| The condition may reference the entry table and every joined table. Unqualified fields read the entry table.          | Same scope as `@db.view.filter`; other tables are a compile-time error.                         |
| The condition uses the [view predicate grammar](./#view-filters) (no `matches`).                                      | Same grammar as join conditions and `@db.view.filter`.                                          |
| `@db.view.having` can filter on a conditional alias (`paidOrders > 0`).                                               | The SQL builder repeats the whole `CASE` expression in `HAVING`.                                |

::: tip Unconditional SUM over only nulls
Without a condition, a group whose values are all null sums to `NULL` on SQL and to `0` on MongoDB. This is a long-standing difference between the engines and is unchanged. Use a conditional `sum` when you need `0` everywhere.
:::

## The GROUP BY Pattern

When a view contains aggregation annotations, non-aggregated fields automatically become `GROUP BY` columns. This is how the database knows how to group the data before computing aggregates.

```atscript
@db.view 'category_stats'
@db.view.for Order
export interface CategoryStats {
    category: Order.category      // plain field → GROUP BY

    @db.agg.sum "amount"
    totalRevenue: number          // aggregated

    @db.agg.count
    orderCount: number            // aggregated

    @db.agg.avg "amount"
    avgOrderValue: number         // aggregated
}
```

This produces SQL equivalent to:

```sql
SELECT category, SUM(amount) AS totalRevenue, COUNT(*) AS orderCount,
       AVG(amount) AS avgOrderValue
FROM orders
GROUP BY category
```

Multiple plain fields create multi-column grouping:

```atscript
category: Order.category     // GROUP BY column 1
region: Order.region         // GROUP BY column 2

@db.agg.sum "amount"
totalRevenue: number         // aggregated per (category, region)
```

When **all** fields are aggregated (no plain fields), there is no `GROUP BY` — the aggregation runs across the entire table, producing a single result row.

## Type Constraints

| Annotation              | Allowed field types | Validates at |
| ----------------------- | ------------------- | ------------ |
| `@db.agg.sum`           | `number`, `decimal` | Compile time |
| `@db.agg.avg`           | `number`, `decimal` | Compile time |
| `@db.agg.count`         | `number`            | Compile time |
| `@db.agg.countDistinct` | `number`            | Compile time |
| `@db.agg.min`           | Any comparable      | —            |
| `@db.agg.max`           | Any comparable      | —            |

Atscript validates type compatibility at build time — annotating a `string` field with `@db.agg.sum` produces a compile error.

## Runtime Aggregation: Quantity Dimensions

The annotations above define **view-time** aggregations: shape baked into the schema. For **ad-hoc** aggregations via `table.aggregate()` at runtime, see [Grouped Queries](/api/aggregation).

One constraint worth knowing here, because it surfaces the same way against view aggregates: when the source column carries `@db.amount.currency.ref` or `@db.unit.ref` (see [Annotations § Quantity Tagging](../adapters/annotations#quantity-tagging-currency-unit)), the runtime rejects ad-hoc aggregations that don't include the referenced dimension in `$groupBy`. Summing rows that mix currencies — or kg with lb — is meaningless, and the guard catches it before it reaches the database.

```ts
// Schema: amount carries @db.amount.currency.ref 'currency'
await orders.aggregate({
  filter: {},
  controls: {
    $groupBy: ["status"], // ← missing 'currency'
    $select: ["status", { $fn: "sum", $field: "amount", $as: "total" }],
  },
});
// → DbError("INVALID_QUERY"): Aggregate "sum(amount)" requires "currency" in $groupBy
```

Add the ref field to `$groupBy` (`["status", "currency"]`) and the query proceeds. Literal forms (`@db.amount.currency 'EUR'`, `@db.unit 'qps'`) impose no constraint — the dimension is fixed schema-wide. `COUNT(*)` is exempt either way.

## Annotation Reference

| Annotation                      | Argument           | Required? | SQL Equivalent          |
| ------------------------------- | ------------------ | --------- | ----------------------- |
| `@db.agg.sum "field"`           | Source column name | Yes       | `SUM(field)`            |
| `@db.agg.avg "field"`           | Source column name | Yes       | `AVG(field)`            |
| `@db.agg.count`                 | None (or `'*'`)    | —         | `COUNT(*)`              |
| `@db.agg.count "field"`         | Source column name | Optional  | `COUNT(field)`          |
| `@db.agg.countDistinct "field"` | Source column name | Yes       | `COUNT(DISTINCT field)` |
| `@db.agg.min "field"`           | Source column name | Yes       | `MIN(field)`            |
| `@db.agg.max "field"`           | Source column name | Yes       | `MAX(field)`            |

Each one takes an optional second argument, a query that makes it [conditional](#conditional-aggregates).

::: info Compiled metadata shape
The compiled `db.agg.*` metadata is an object, `{ field?, condition? }`. Code that reads it directly must also accept the older shapes — see [Upgrading → 0.1.136](/guide/upgrading#v0-1-136).
:::

## Next Steps

- [Aggregation Views](./aggregation-views) — combining views with aggregation annotations
- [Defining Views](./) — view structure, joins, and filters
- [Querying Views](./querying-views) — reading aggregation results at runtime
