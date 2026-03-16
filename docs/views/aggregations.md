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
latestOrder: number
```

Accepts any comparable type.

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

| Annotation      | Allowed field types | Validates at |
| --------------- | ------------------- | ------------ |
| `@db.agg.sum`   | `number`, `decimal` | Compile time |
| `@db.agg.avg`   | `number`, `decimal` | Compile time |
| `@db.agg.count` | `number`            | Compile time |
| `@db.agg.min`   | Any comparable      | —            |
| `@db.agg.max`   | Any comparable      | —            |

Atscript validates type compatibility at build time — annotating a `string` field with `@db.agg.sum` produces a compile error.

## Annotation Reference

| Annotation              | Argument           | Required? | SQL Equivalent |
| ----------------------- | ------------------ | --------- | -------------- |
| `@db.agg.sum "field"`   | Source column name | Yes       | `SUM(field)`   |
| `@db.agg.avg "field"`   | Source column name | Yes       | `AVG(field)`   |
| `@db.agg.count`         | None               | —         | `COUNT(*)`     |
| `@db.agg.count "field"` | Source column name | Optional  | `COUNT(field)` |
| `@db.agg.min "field"`   | Source column name | Yes       | `MIN(field)`   |
| `@db.agg.max "field"`   | Source column name | Yes       | `MAX(field)`   |

## Next Steps

- [Aggregation Views](./aggregation-views) — combining views with aggregation annotations
- [Defining Views](./) — view structure, joins, and filters
- [Querying Views](./querying-views) — reading aggregation results at runtime
