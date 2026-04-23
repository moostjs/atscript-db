# tables-and-views

## DbSpace

Registry for tables and views. Each readable owns its own adapter instance; the factory runs once per type.

```ts
import { DbSpace } from "@atscript/db";
const db = new DbSpace(() => new SqliteAdapter(driver)); // factory, not a singleton adapter

db.getTable(UsersType); // → AtscriptDbTable<typeof UsersType>, cached per type
db.getView(ActiveUsersView); // → AtscriptDbView<typeof ActiveUsersView>
db.get(AnyType); // → auto-detects table vs view from metadata

db.getAdapter(UsersType); // → BaseDbAdapter (for adapter-specific escape hatches)
await db.dropTableByName("todos");
await db.dropViewByName("active_todos");
```

Pass an app logger as the second arg to propagate to every adapter:

```ts
new DbSpace(adapterFactory, myLogger);
```

## AtscriptDbReadable (common to tables + views)

| Member                                 | Purpose                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `tableName: string`                    | Resolved physical name (adapter override > `@db.table` > `@db.view` > interface id). |
| `schema: string \| undefined`          | From `@db.schema`.                                                                   |
| `primaryKeys: readonly string[]`       | PK field names (multiple = composite).                                               |
| `indexes: Map<name, TDbIndex>`         | Resolved index definitions.                                                          |
| `relations: Map<name, TDbRelation>`    | Nav relations.                                                                       |
| `foreignKeys: Map<key, TDbForeignKey>` | Resolved FK constraints.                                                             |
| `flatMap: Map<path, type>`             | All fields as dot-notation paths.                                                    |
| `columnMap: Map<logical, physical>`    | From `@db.column`.                                                                   |
| `navFields: ReadonlySet<string>`       | Fields that are `@db.rel.to/.from/.via`.                                             |
| `dbAdapter / getAdapter()`             | Underlying adapter instance.                                                         |
| `setVerbose(bool)`                     | Toggles DB debug logging (zero cost when disabled).                                  |
| `findOne(q) / findMany(q) / count(q)`  | Read ops (signatures in `crud.md`).                                                  |
| `aggregate(q)`                         | Group-by aggregation (see `queries.md`).                                             |

Metadata is built lazily on first access — safe to reference from peer tables.

## AtscriptDbTable — extra surface

| Member                                   | Purpose                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `insertOne / insertMany`                 | CRUD writes.                                                                                     |
| `replaceOne / replaceMany / bulkReplace` | Full replace by PK.                                                                              |
| `updateOne / updateMany / bulkUpdate`    | Patch by PK or filter.                                                                           |
| `deleteOne / deleteMany`                 | Delete.                                                                                          |
| `ensureTable()`                          | Creates the table if missing (used by `syncSchema`).                                             |
| `syncIndexes()`                          | Diffs + creates/drops managed indexes.                                                           |
| `withTransaction(fn)`                    | Runs `fn` in a transaction; nested calls reuse the existing transaction via `AsyncLocalStorage`. |

## AtscriptDbView — extra surface

| Member                         | Purpose                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `isView: true`                 | Differentiator from tables.                                                          |
| `viewPlan`                     | Computed plan (entry table + joins + filter + groupBy).                              |
| `isExternal`                   | True when neither `@db.view.for` nor joins are present — assumed pre-existing in DB. |
| `findOne/Many/count/aggregate` | Read-only ops; writes throw.                                                         |

### View kinds

| Kind         | How declared                                                         |
| ------------ | -------------------------------------------------------------------- |
| Managed      | `@db.view` + `@db.view.for <Entry>` [+ `@db.view.joins` ...]         |
| Materialized | Managed view + `@db.view.materialized`                               |
| External     | `@db.view` only (no `@db.view.for`); Atscript never creates/drops it |

```atscript
@db.view 'active_tasks'
@db.view.for Task
@db.view.joins User, `User.id = Task.assigneeId`
@db.view.filter `Task.status = 'active'`
interface ActiveTask {
    id: Task.id
    title: Task.title
    assigneeName?: User.name
}
```

## Aggregate views

Combine `@db.column.dimension` (group keys) + `@db.agg.*` (measures):

```atscript
@db.view
@db.view.for Order
@db.view.having `totalRevenue > 100`
interface CategoryStats {
    @db.column.dimension
    category: Order.category
    @db.agg.sum 'amount'
    totalRevenue: number
    @db.agg.count
    orderCount: number
}
```

## Lifecycle

| Op                               | Triggers                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `db.getTable(T)` first call      | Adapter factory → `new AtscriptDbTable(...)` → `adapter.registerReadable(readable)`.           |
| `table.ensureTable()`            | Creates the physical table/collection if missing. Idempotent.                                  |
| `table.syncIndexes()`            | Diffs declared indexes vs existing (filtered by `atscript__` prefix) and applies changes.      |
| `syncSchema(space, types, opts)` | Locks → ensures tables → applies column/index/FK diff → stores snapshot. See `schema-sync.md`. |

Tables are created once per type within a `DbSpace`; dropping and re-creating a `DbSpace` is the only way to replace an adapter factory.
