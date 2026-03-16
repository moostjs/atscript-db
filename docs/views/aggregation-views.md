---
outline: deep
---

# Aggregation Views

<!--@include: ../_experimental-warning.md-->

The primary way to use aggregations is by combining `@db.view` with `@db.agg.*` annotations. This creates database views that compute grouped statistics — sums, averages, counts — automatically.

## How It Works

1. Define your source table(s) with `@db.table`
2. Create a view interface with `@db.view` and `@db.view.for`
3. Add plain fields — these become `GROUP BY` columns
4. Add aggregated fields with `@db.agg.*` annotations
5. Schema sync generates a `CREATE VIEW` with `SELECT ... GROUP BY ...`

## Step-by-Step Example

Start with a source table:

```atscript
@db.table 'orders'
export interface Order {
    @meta.id
    id: number

    category: string
    amount: number
    status: string
    createdAt: number.timestamp
}
```

Define an aggregation view over it:

```atscript
import { Order } from './order'

@db.view 'order_stats'
@db.view.for Order
export interface OrderStats {
    category: Order.category       // GROUP BY column

    @db.agg.sum "amount"
    totalRevenue: number           // SUM(amount)

    @db.agg.count
    orderCount: number             // COUNT(*)

    @db.agg.avg "amount"
    avgOrderValue: number          // AVG(amount)
}
```

Schema sync generates SQL equivalent to:

```sql
CREATE VIEW order_stats AS
SELECT category,
       SUM(amount) AS totalRevenue,
       COUNT(*) AS orderCount,
       AVG(amount) AS avgOrderValue
FROM orders
GROUP BY category
```

## Pre-Aggregation Filtering

Use `@db.view.filter` to add a `WHERE` clause that filters rows **before** aggregation:

```atscript
@db.view 'active_order_stats'
@db.view.for Order
@db.view.filter `Order.status = 'completed'`
export interface ActiveOrderStats {
    category: Order.category

    @db.agg.sum "amount"
    totalRevenue: number

    @db.agg.count
    orderCount: number
}
```

Only completed orders are included in the sums and counts. The filter runs as a SQL `WHERE` clause before grouping.

## Post-Aggregation Filtering (HAVING)

Use `@db.view.having` to filter **after** aggregation — on the computed values themselves:

```atscript
@db.view 'top_categories'
@db.view.for Order
@db.view.having `totalRevenue > 1000`
export interface TopCategories {
    category: Order.category

    @db.agg.sum "amount"
    totalRevenue: number

    @db.agg.count
    orderCount: number
}
```

The `HAVING` clause references **view field aliases** (`totalRevenue`), not source table columns. The SQL builder resolves these to their aggregate expressions:

```sql
... GROUP BY category HAVING SUM(amount) > 1000
```

::: info
You can combine `@db.view.filter` and `@db.view.having` — the filter narrows rows before grouping, and the having clause filters the aggregated results.
:::

## Multi-Table Aggregation Views

Use `@db.view.joins` to aggregate across joined tables:

```atscript
import { Order } from './order'
import { Category } from './category'

@db.view 'category_revenue'
@db.view.for Order
@db.view.joins Category, `Category.id = Order.categoryId`
export interface CategoryRevenue {
    categoryName: Category.name    // GROUP BY — from joined table

    @db.agg.sum "amount"
    totalRevenue: number

    @db.agg.count
    orderCount: number

    @db.agg.max "amount"
    largestOrder: number
}
```

This joins `orders` with `categories` and groups by the category name, computing revenue aggregates per category.

## Querying Aggregation Views

Aggregation views are queried with the same API as regular views — via `AtscriptDbView`:

```typescript
import { DbSpace } from "@atscript/db";
import { OrderStats } from "./schema/order-stats.as";

const db = new DbSpace(adapterFactory);
const stats = db.getView(OrderStats);

// All categories
const all = await stats.findMany({});

// Sort by revenue, descending
const topCategories = await stats.findMany({
  controls: { $sort: { totalRevenue: -1 }, $limit: 10 },
});

// Count categories with orders
const categoryCount = await stats.count({});
```

Via HTTP, aggregation views use `AsDbReadableController` — the same read-only endpoints as regular views. See [HTTP — Advanced](/http/advanced) for URL query syntax.

## Complete Example

Putting it all together — source table, aggregation view with joins, filter, and having:

```atscript
import { Order } from './order'
import { Category } from './category'

@db.view 'top_category_stats'
@db.view.for Order
@db.view.joins Category, `Category.id = Order.categoryId`
@db.view.filter `Order.status = 'completed'`
@db.view.having `totalRevenue > 500`
export interface TopCategoryStats {
    categoryName: Category.name

    @db.agg.sum "amount"
    totalRevenue: number

    @db.agg.count
    orderCount: number

    @db.agg.avg "amount"
    avgOrderValue: number
}
```

Generated SQL (conceptual):

```sql
CREATE VIEW top_category_stats AS
SELECT categories.name AS categoryName,
       SUM(orders.amount) AS totalRevenue,
       COUNT(*) AS orderCount,
       AVG(orders.amount) AS avgOrderValue
FROM orders
JOIN categories ON categories.id = orders.categoryId
WHERE orders.status = 'completed'
GROUP BY categories.name
HAVING SUM(orders.amount) > 500
```

TypeScript usage:

```typescript
const stats = db.getView(TopCategoryStats);

const results = await stats.findManyWithCount({
  controls: { $sort: { totalRevenue: -1 }, $limit: 20 },
});

console.log(results.data); // top categories by revenue
console.log(results.count); // total matching categories
```

## Next Steps

- [Querying Views](./querying-views) — full API for reading view data
- [Aggregation Annotations](./aggregations) — annotation reference for all aggregate functions
- [Defining Views](./) — view structure, joins, and filters
- [HTTP — Advanced](/http/advanced) — accessing views over HTTP
