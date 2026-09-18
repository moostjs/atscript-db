---
outline: deep
---

# View Types

<!--@include: ../_experimental-warning.md-->

Atscript supports three kinds of database views, differing in whether schema sync manages them and whether results are physically stored.

## Overview

| Type                  | Created by sync? | Stored?           | Use case                                        |
| --------------------- | ---------------- | ----------------- | ----------------------------------------------- |
| **Managed** (virtual) | Yes              | No — query-based  | Joins, filters, projections you define in `.as` |
| **Materialized**      | Yes              | Yes — precomputed | Performance-critical aggregations and summaries |
| **External**          | No               | Already exists    | Pre-existing views not managed by Atscript      |

## Managed Views

A managed view has `@db.view.for` — schema sync creates, updates, and drops it automatically. The view SQL is generated from your annotations (joins, filter, having):

```atscript
@db.view 'active_tasks'
@db.view.for Task
@db.view.joins User, `User.id = Task.assigneeId`
@db.view.filter `Task.status != 'done'`
export interface ActiveTask {
    id: Task.id
    title: Task.title
    assigneeName?: User.name
}
```

Managed views are the most common type. Schema sync tracks changes to the view definition and recreates the view when it detects a difference.

::: tip
Use `@db.view.renamed` when renaming a view so sync maps the old name to the new one and cleans up the old view — see [Schema Sync Behavior](#schema-sync-behavior) below.
:::

## Materialized Views

Add `@db.view.materialized` to store the view's computed results in the database. Materialized views trade storage space for faster reads — especially useful for complex aggregations:

```atscript
@db.view 'order_stats'
@db.view.for Order
@db.view.materialized
export interface OrderStats {
    category: Order.category

    @db.agg.sum "amount"
    totalRevenue: number

    @db.agg.count
    orderCount: number
}
```

### Adapter Support

Materialized view support varies by adapter:

| Adapter        | Support         | Implementation                                                      |
| -------------- | --------------- | ------------------------------------------------------------------- |
| **PostgreSQL** | Native          | `CREATE MATERIALIZED VIEW`, refresh via `REFRESH MATERIALIZED VIEW` |
| **MongoDB**    | Via aggregation | `$merge` / `$out` aggregation stage                                 |
| **SQLite**     | Not supported   | Falls back to standard `CREATE VIEW`                                |
| **MySQL**      | Not supported   | Falls back to standard `CREATE VIEW`                                |

::: warning
When an adapter does not support materialized views natively, `@db.view.materialized` is silently ignored and a standard view is created instead. Check your adapter's documentation for details.
:::

See [Querying Views — Refreshing Materialized Views](./querying-views#refreshing-materialized-views) for how to refresh stored results.

## External Views

When you have a pre-existing view in your database that Atscript should not manage, declare it with `@db.view` alone — without `@db.view.for`:

```atscript
@db.view 'legacy_report'
export interface LegacyReport {
    @meta.id
    reportId: number
    title: string
    total: number
}
```

External views:

- Are **not** created, modified, or dropped by [schema sync](/sync/)
- Can be queried with the same API as managed views (see [Querying Views](./querying-views))
- Declare field types directly — no chain references to source tables

This is useful when you have views created by migration scripts, DBAs, or other systems that Atscript should read but not manage.

## Schema Sync Behavior

Schema sync manages the lifecycle of managed and materialized views:

- **Creation** — managed views are created as `CREATE VIEW` statements during sync. If a **physical table** already exists under the view's name, sync refuses the run instead of skipping the view (since 0.1.128).
- **Updates** — views are dropped and recreated when their definition changes (there is no `ALTER VIEW`). The definition is the entry table, the joins **and their `ON` conditions**, `@db.view.filter`, `@db.view.having`, the materialized flag and the field set (since 0.1.128; before, join conditions and `having` were not part of it). `@db.ignore` fields are not part of the definition and are not selected by the generated `CREATE VIEW`.
- **Renames** — track view renames with `@db.view.renamed` so sync drops the view under its old name and creates it under the new one (instead of leaving the old view behind):

```atscript
@db.view 'premium_users'
@db.view.renamed 'vip_users'
@db.view.for User
@db.view.filter `User.status = 'active'`
export interface PremiumUsers {
    id: User.id
    name: User.name
}
```

- **External views** — ignored by sync entirely

::: warning Upgrading to 0.1.128
Because join conditions and `having` now participate in the definition hash, every managed view that has joins, a filter or a having clause is recreated **once** on the first sync after upgrading. On PostgreSQL that discards the view's `GRANT`s (re-grant them), and a user-created view depending on a managed view makes the recreate fail with an `error` entry until it is dropped or the managed view is excluded from the inventory — sync never drops with `CASCADE`. On MongoDB materialized views are plain views, so the recreate is metadata-only.
:::

For full details on the sync process, see [Schema Sync](/sync/).

## Next Steps

- [Defining Views](./) — annotation reference for building views
- [Aggregation Annotations](./aggregations) — computing sums, averages, and counts in views
- [Querying Views](./querying-views) — read-only API for accessing view data
- [Schema Sync](/sync/) — how sync manages the full lifecycle of views and tables
