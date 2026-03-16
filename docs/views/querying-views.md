---
outline: deep
---

# Querying Views

<!--@include: ../_experimental-warning.md-->

Views are read-only — you can query them with the same filter, sort, and pagination controls as tables, but no write operations are available.

## Registering Views

Use `db.getView()` to get a read-only `AtscriptDbView` instance:

```typescript
import { DbSpace } from "@atscript/db";
import { ActiveTask } from "./schema/active-task.as";

const db = new DbSpace(adapterFactory);
const view = db.getView(ActiveTask);
```

`getView()` returns a cached instance — calling it again with the same type returns the same view. See [Setup](/guide/setup) for how to create a `DbSpace`.

## Read Operations

`AtscriptDbView` provides all the read operations from `AtscriptDbReadable`:

### findMany

Retrieve multiple records matching a query:

```typescript
const tasks = await view.findMany({
  filter: { projectTitle: "Website" },
  controls: { $sort: { title: 1 }, $limit: 20 },
});
```

### findOne

Retrieve a single record:

```typescript
const task = await view.findOne({
  filter: { assigneeName: "Alice" },
});
```

### findManyWithCount

Retrieve records and total count in a single call — useful for pagination:

```typescript
const result = await view.findManyWithCount({
  filter: { status: "in_progress" },
  controls: { $skip: 20, $limit: 10 },
});

console.log(result.data); // 10 records (page 3)
console.log(result.count); // total matching records
```

### count

Count records matching a query:

```typescript
const total = await view.count({
  filter: { status: "in_progress" },
});
```

### findById

Look up a single record by primary key (if the view has `@meta.id`):

```typescript
const task = await view.findById(42);
```

## Filtering and Sorting

Filters apply to the view's output columns, not directly to source tables:

```typescript
// Filter on a view field (even if it's aggregated)
const topCategories = await stats.findMany({
  filter: { orderCount: { $gte: 100 } },
  controls: { $sort: { totalRevenue: -1 } },
});
```

- **Sorting** works on any view field, including aggregated fields
- **Pagination** via `$skip` and `$limit` works as expected
- **Field selection** via `$select` picks specific columns from the view output

For the full query syntax, see [Queries & Filters](/api/queries).

## HTTP Access

Use `AsDbReadableController` to expose a view as a read-only HTTP endpoint:

```typescript
import { AsDbReadableController } from "@atscript/moost-db";
import { ActiveTask } from "./schema/active-task.as";

@Controller("active-tasks")
export class ActiveTaskController extends AsDbReadableController(ActiveTask) {}
```

This provides:

- `GET /active-tasks` — list with filter, sort, pagination
- `GET /active-tasks/:id` — single record by ID

No `POST`, `PUT`, `PATCH`, or `DELETE` endpoints — views are read-only.

The same URL query syntax applies (`$sort`, `$skip`, `$limit`, `$select`, `$filter`). See [HTTP — CRUD Endpoints](/http/crud) for details.

## Refreshing Materialized Views

Materialized views store precomputed results that need periodic refreshing. Refresh behavior is adapter-specific:

| Adapter        | Refresh method                                |
| -------------- | --------------------------------------------- |
| **PostgreSQL** | `REFRESH MATERIALIZED VIEW` (native)          |
| **MongoDB**    | Re-run aggregation pipeline with `$merge`     |
| **SQLite**     | Not applicable (no materialized view support) |
| **MySQL**      | Not applicable (no materialized view support) |

::: info
Materialized view refresh is currently an adapter-level operation — there is no high-level API on `AtscriptDbView`. Consult your adapter's documentation for refresh mechanics.
:::

## Next Steps

- [Defining Views](./) — how to define views in `.as` files
- [View Types](./view-types) — managed, materialized, and external views
- [Aggregation Views](./aggregation-views) — views with computed aggregates
- [CRUD Operations](/api/crud) — table read operations (same API)
- [HTTP — CRUD Endpoints](/http/crud) — HTTP endpoint reference
