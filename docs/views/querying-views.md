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

- **Sorting** works on any view field, including aggregated fields and [computed columns](./computed-columns) — a computed `rank` gives a global ranking that pages stably (`$sort: { rank: -1, id: 1 }`)
- **Pagination** via `$skip` and `$limit` works as expected
- **Field selection** via `$select` picks specific columns from the view output

For the full query syntax, see [Queries & Filters](/api/queries).

## Performance: Unused Joins Are Skipped

Since 0.1.153, a read of a managed view on MySQL, SQLite and MongoDB skips every `left` join it does not need. A `count()`, or a page that selects only entry-table columns, reads the entry table alone instead of probing every joined table for every row:

```typescript
// vp_order_view joins customers, regions, products, notes, … — all `left`
await orders.count({ filter: { amount: { $gt: 100 } } });
// MySQL: SELECT COUNT(*) FROM (SELECT … FROM `vp_orders`) AS `vp_order_view` WHERE `amount` > ?

await orders.findMany({ filter: {}, controls: { $select: ["id", "customerName"], $limit: 20 } });
// keeps the customers join (and any join its ON clause reads), skips the rest
```

The result is always the same as reading the stored view. A join is skipped only when **both** hold:

1. **Nothing in the read uses it.** The read's `$select` (no `$select` = every column), filter, `$sort`, `$groupBy`, aggregates and `$having` name none of its columns — nor of a [computed column](./computed-columns) built on them, nor the ON clause of another join the read keeps, nor the view's `@db.view.filter`.
2. **It can never add or remove rows.** It is a `left` join to a table (not a view) that matches at most one row:
   - a [first-row join](./#first-row-joins), or
   - an ON clause that is a plain `and` of `=` comparisons covering **every** field of the target's primary key or of one of its unique indexes (`@db.index.unique`). Each such field must be compared with a field of the same type and collation, or with a literal of its type. Extra conditions are fine — they only narrow the match.

So these joins are **never** skipped: `inner` joins, joins whose ON uses `or` / `not`, joins on a non-unique column (or on part of a composite unique key), joins to a view. Grouped views (`@db.agg.*`), materialized views and external views are always read as stored. On MongoDB a unique key over an **optional** field does not count (its index is partial — a missing value would match many documents).

Model the uniqueness you rely on. The decision is taken from the `.as` model, not from the database: a join on `code` is skippable only when `code` is declared `@db.index.unique` (and the index exists — run schema sync).

### Per adapter

| Adapter    | Default | How                                                                                                                                 |
| ---------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| MySQL      | on      | Reads an inline copy of the view's definition without the skipped joins, with a `MERGE` hint (merged even with `derived_merge=off`) |
| SQLite     | on      | Same inline definition (SQLite skips unused joins itself only outside `COUNT(*)` and aggregates)                                    |
| MongoDB    | on      | Runs the view's pipeline on the entry collection without the skipped joins' `$lookup` + `$unwind`                                   |
| PostgreSQL | —       | Not needed: PostgreSQL removes such joins itself, through views, `COUNT(*)` and first-row joins included                            |

To read a view by name again, pass `viewJoinPruning: false` to the adapter (for a whole space), or set it on one view's adapter:

```typescript
createAdapter(uri, { viewJoinPruning: false }); // MySQL, SQLite, MongoDB
new MysqlAdapter(driver, { viewJoinPruning: false });
new SqliteAdapter(driver, { viewJoinPruning: false });
new MongoAdapter(db, client, { viewJoinPruning: false });

db.getAdapter(OrderView).viewJoinPruning = false; // just this view
```

::: warning Reads use the definition in your model
A skipped-join read runs the view definition generated from the `.as` model, not the one stored in the database. A view altered by hand in the database (outside schema sync) is honoured only by reads that skip nothing — keep views managed by [schema sync](/sync/), or turn pruning off for that view.

Such a read also reads the entry and joined tables (collections) directly: a database user granted access to the view but not to its tables needs `viewJoinPruning: false`.
:::

**DOs and DON'Ts**

- Do declare the unique index a lookup join relies on — without it the join is always read.
- Do pass `$select` on hot list endpoints: without it every column (and so every join that feeds one) is read.
- Don't expect a join used only to **filter** rows (an `inner` join, or one the view filter reads) to be skipped — dropping it would change the rows.
- MongoDB: a read that carries an operation-wide collation (a filter on a `@db.column.collate` field) reads the stored view.

## HTTP Access

Use `AsDbReadableController` to expose a view as a read-only HTTP endpoint:

```typescript
import { AsDbReadableController, ReadableController } from "@atscript/moost-db";
import { ActiveTask } from "./schema/active-task.as";

@ReadableController(ActiveTask, "active-tasks")
export class ActiveTaskController extends AsDbReadableController<typeof ActiveTask> {}
```

This provides:

- `GET /active-tasks/query` — list with filter, sort, pagination
- `GET /active-tasks/pages` — paginated results with metadata
- `GET /active-tasks/one/:id` — single record by ID
- `GET /active-tasks/meta` — view metadata

No `POST`, `PUT`, `PATCH`, or `DELETE` endpoints — views are read-only.

The same [URL query syntax](/http/query-syntax) applies — field filters, `$sort`, `$skip`, `$limit`, `$select`. See [HTTP — CRUD Endpoints](/http/crud) for details.

### Value help through reference chains

A view field is declared through its source column (`projectId: Task.projectId`), and the DB layer keeps that first hop — it is the column the view reads. Since 0.1.128 the `/meta` endpoint resolves the chain to its **terminal** field instead: when `Task.projectId: Project.id` carries `@db.rel.FK`, the view's `projectId` is serialized with `ref → Project.id` (shallow, `refDepth` stays `0.5`) and `db.rel.FK: true`, so the client value-help picker opens the projects endpoint rather than the tasks endpoint. Fields over plain columns keep their direct ref and gain no marker.

### Row actions on a view

Since 0.1.147 a view controller can list its source table's row actions with `@DbActionsFrom(() => SourceController)` — the actions stay the source's, the view maps its rows to source ids. See [Actions on a View](/http/view-actions).

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

## See Also: Ad-Hoc Aggregation

Views are the right tool when the aggregation shape is stable. For dynamic, query-time aggregations against a regular `@db.table`, use `table.aggregate()` — pass `$groupBy` and `$select` (with `$fn: 'sum' | 'avg' | 'min' | 'max' | 'count'`, or a [calendar bucket](/api/calendar-buckets)) inline per call. See [Grouped Queries](/api/aggregation).

## Next Steps

- [Defining Views](./) — how to define views in `.as` files
- [View Types](./view-types) — managed, materialized, and external views
- [Aggregation Views](./aggregation-views) — views with computed aggregates
- [CRUD Operations](/api/crud) — table read operations (same API)
- [HTTP — CRUD Endpoints](/http/crud) — HTTP endpoint reference
