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

Use `@db.view.joins` to bring in columns from other tables. Each join takes a target type, a condition written as a [query expression](/api/queries), and an optional kind (since 0.1.136):

```atscript
@db.view 'active_tasks'
@db.view.for Task
@db.view.joins Project, `Project.id = Task.projectId`
@db.view.joins User, `User.id = Task.assigneeId`, 'left'
export interface ActiveTask {
    id: Task.id
    title: Task.title
    projectTitle: Project.title
    assigneeName?: User.name   // left join — NULL when the task has no assignee
}
```

The annotation is repeatable. Joins apply in declaration order, on every adapter:

| Kind                | Written as         | Rows without a match                                          |
| ------------------- | ------------------ | ------------------------------------------------------------- |
| `inner` _(default)_ | no third argument  | dropped — like SQL `JOIN`                                     |
| `left`              | `'left'` (3rd arg) | kept, with the joined table's fields `NULL` — SQL `LEFT JOIN` |

Rules for joined fields (checked at compile time):

- **A field read from a left-joined table must be optional** (`assigneeName?: User.name`) — unmatched rows carry `NULL`. `@db.agg.count` and `@db.agg.countDistinct` fields are exempt (they count `0`); `sum`/`avg`/`min`/`max` over a left-joined table are not.
- **Chained joins.** A join condition may reference the entry table and any join declared **before** it — so you can walk `Order → Customer → Region`:

  ```atscript
  @db.view.for Order
  @db.view.joins Customer, `Customer.id = Order.customerId`
  @db.view.joins Region, `Region.id = Customer.regionId`, 'left'
  ```

  Referencing a join declared later is an error (`… not in scope — a join may reference the entry table and joins declared before it`).

- **One join per table.** Joining the same table twice, or joining the entry table, is rejected — join aliases and self-joins are not supported yet.

::: warning A filter on a left-joined table makes the join inner
`@db.view.filter` runs after the joins, so a condition on a left-joined table (`` `User.status = 'active'` ``) is false for unmatched rows and drops them — the view behaves as an inner join. Put conditions that should only restrict the _match_ into the join condition instead:
`` `User.id = Task.assigneeId and User.status = 'active'` ``.
:::

::: info Upgrading to 0.1.136
MongoDB used to keep unmatched documents for every join. Add `'left'` where you relied on that — see [Upgrading → 0.1.136](/guide/upgrading#v0-1-136).
:::

## View Filters

The `@db.view.filter` annotation adds a `WHERE` clause using backtick [query expression](/api/queries) syntax:

```atscript
@db.view.filter `Task.status != 'done'`
```

You can reference any table in scope — both the entry table and all joined tables. View predicates (join conditions, filters, `@db.view.having`) support `=`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not in`, `exists` / `not exists` and `and` / `or` / `not`; `matches` is rejected at sync on SQL adapters and inside MongoDB join conditions:

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

    @db.ignore
    displayLabel?: string     // no column: excluded from CREATE VIEW (since 0.1.128)
}
```

View fields name **logical** paths — `Task.title`, `User.address.city` — and the view reads the **physical** column behind them: a flattened nested field (`address__city`), a `@db.column` rename on the source, or a renamed key on MongoDB. The view's own columns follow the same rules as a table's: a view field with `@db.column` gets that column name, and an object-typed view field over a flattened source object is flattened into one view column per leaf. An object field over a `@db.json` source column needs `@db.json` on the view field too — otherwise sync fails with `source is a JSON column — add @db.json to the view field`. A field can also read a single primitive leaf inside a JSON column — see [Reading JSON leaves](#reading-json-leaves).

A view field annotated with `@db.ignore` has no column anywhere — it is excluded from the generated `SELECT` list, from the view's definition hash and from queries, exactly like an ignored table field. A view field, join condition or filter that reads a **source** field with `@db.ignore`, or a navigation relation, fails the sync: `… has no column — "x" is @db.ignore or a navigation relation`.

## Reading JSON Leaves

Since 0.1.136 a view field can reference a primitive leaf **inside** a `@db.json` column. The view extracts it into a typed column you can filter, sort and group like any other:

```atscript
@db.table 'users'
export interface User {
    @meta.id
    id: number

    @db.json
    settings?: {
        theme?: string
        fontSize?: number
        beta?: boolean
    }
}

@db.view.for User
export interface UserPrefs {
    id: User.id
    theme?: User.settings.theme
    fontSize?: User.settings.fontSize
    beta?: User.settings.beta
}
```

The leaf must be a `string`, `number` or `boolean` (checked at compile time). The column holds the **declared** type, or `null` when:

| Stored JSON                                  | `theme` (string) | `fontSize` (number) | `beta` (boolean) |
| -------------------------------------------- | ---------------- | ------------------- | ---------------- |
| `{"theme":"dark","fontSize":14,"beta":true}` | `"dark"`         | `14`                | `true`           |
| key missing, or `settings` is `NULL`         | `null`           | `null`              | `null`           |
| JSON `null`                                  | `null`           | `null`              | `null`           |
| another JSON type (`7`, `"14"`, `1`)         | `null`           | `null`              | `null`           |

Values are never coerced — the string `"14"` is not a number, `1` is not `true`. Numbers are read as doubles, so integers beyond 2^53 lose precision.

The leaf works everywhere a view column does: in the `SELECT` list, as a `GROUP BY` dimension of an [aggregation view](./aggregation-views), as the source of `@db.agg.*`, and in `@db.view.having`. Join conditions and `@db.view.filter` can't read inside a JSON column — on SQL adapters sync fails with `JSON paths are not supported in view conditions`.

::: warning Not indexed
An extracted column is computed per row when the view is read. Filters and sorts on it scan the source table; no index backs them.
:::

**Per adapter:**

- **SQLite, MySQL / MariaDB, PostgreSQL** — the view guards the type with the database's JSON type function, so the rules above hold even for rows written outside atscript-db. SQLite and MySQL return booleans as `0`/`1`; view reads convert them to `true`/`false`.
- **MongoDB** — the view reads the document path (`settings.theme`) directly, with **no type guard**: a value of another type written outside atscript-db (table writes are validated) comes back as stored.

A path segment containing `"`, `\` or a control character can't be extracted — sync fails with `JSON path segment … can't be extracted`.

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
