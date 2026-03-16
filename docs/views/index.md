---
outline: deep
---

# Defining Views

<!--@include: ../_experimental-warning.md-->

Views are read-only computed datasets derived from one or more tables. Like tables, they are defined in `.as` files — but instead of full CRUD, views produce read-only query interfaces with joins, filters, and computed columns declared right in your schema.

## Marking an Interface as a View

Add `@db.view` to an interface to declare it as a database view:

```atscript
@db.view
export interface ActiveTask {
    // ...
}
```

You can optionally provide a name for the view in the database:

```atscript
@db.view 'active_tasks'
export interface ActiveTask {
    // ...
}
```

If omitted, the interface name is used directly.

::: info
An interface cannot be both `@db.table` and `@db.view` — it's one or the other.
:::

## Entry Table

The `@db.view.for` annotation specifies the primary (entry) table for the view. This is the table that drives the query — all joins are relative to it:

```atscript
@db.view 'active_tasks'
@db.view.for Task
export interface ActiveTask {
    id: Task.id
    title: Task.title
    status: Task.status
}
```

Every managed view requires `@db.view.for`. Without it, the view is treated as [external](./view-types#external-views) — a reference to a pre-existing database view not managed by Atscript.

## Joins

Use `@db.view.joins` to bring in columns from related tables. Each join takes a target type and a condition written as a [query expression](/api/queries):

```atscript
@db.view 'active_tasks'
@db.view.for Task
@db.view.joins User, `User.id = Task.assigneeId`
@db.view.joins Project, `Project.id = Task.projectId`
export interface ActiveTask {
    id: Task.id
    title: Task.title
    assigneeName: User.name
    projectTitle: Project.title
}
```

The annotation is repeatable — add as many joins as you need. Each generates a `JOIN` in the resulting SQL (MongoDB uses `$lookup` with left-join semantics).

Fields from joined tables can be marked optional since the join may not match every row:

```atscript
assigneeName?: User.name   // optional — task may have no assignee
projectTitle: Project.title // required — every task has a project
```

## View Filters

The `@db.view.filter` annotation adds a `WHERE` clause using backtick [query expression](/api/queries) syntax:

```atscript
@db.view.filter `Task.status != 'done'`
```

You can reference any table in scope — both the entry table and all joined tables:

```atscript
@db.view.filter `Task.status != 'done' && Task.priority = 'high'`
```

### Simple Views (No Joins)

A view can filter a single table without any joins:

```atscript
@db.view 'active_users'
@db.view.for User
@db.view.filter `User.status = 'active'`
export interface ActiveUser {
    id: User.id
    name: User.name
    email: User.email
}
```

## HAVING Clause

The `@db.view.having` annotation adds a post-aggregation filter (SQL `HAVING` clause). It references **view field aliases**, not source table columns:

```atscript
@db.view 'category_stats'
@db.view.for Order
export interface CategoryStats {
    category: Order.category

    @db.agg.sum "amount"
    totalRevenue: number

    @db.agg.count
    orderCount: number
}

@db.view.having `totalRevenue > 1000`
```

The SQL builder resolves view aliases to their aggregate expressions — `totalRevenue` becomes `SUM(orders.amount)` in the generated `HAVING` clause.

::: tip
The `@db.view.having` annotation is only meaningful when aggregation annotations are present. See [Aggregation Views](./aggregation-views) for the full pattern.
:::

## Field Mapping

View fields map to source table columns via chain references. The view field name can differ from the source column name, creating an alias:

```atscript
@db.view.for Task
@db.view.joins User, `User.id = Task.assigneeId`
export interface TaskSummary {
    taskId: Task.id           // aliased — "taskId" maps to Task.id
    title: Task.title         // same name
    assignee: User.name       // aliased — "assignee" maps to User.name
}
```

## Complete Example

A full view definition with an entry table, two joins, a filter, and field mapping from multiple tables:

```atscript
import { Task } from './task'
import { User } from './user'
import { Project } from './project'

@db.view 'high_priority_tasks'
@db.view.for Task
@db.view.joins User, `User.id = Task.assigneeId`
@db.view.joins Project, `Project.id = Task.projectId`
@db.view.filter `Task.priority = 'high' && Task.status != 'done'`
export interface HighPriorityTask {
    id: Task.id
    title: Task.title
    status: Task.status
    priority: Task.priority
    createdAt: Task.createdAt
    assigneeName?: User.name
    projectTitle: Project.title
}
```

Schema sync translates this into a `CREATE VIEW` statement with the appropriate `SELECT`, `JOIN`, and `WHERE` clauses. See [View Types](./view-types) for how sync manages the view lifecycle, and [Querying Views](./querying-views) for how to read data from views at runtime.

## Next Steps

- [View Types](./view-types) — managed, materialized, and external views
- [Aggregation Annotations](./aggregations) — computing sums, averages, and counts
- [Querying Views](./querying-views) — read-only API for accessing view data
- [Queries & Filters](/api/queries) — query expression syntax used in joins and filters
