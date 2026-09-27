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

| Member                                                | Purpose                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tableName: string`                                   | Resolved physical name (adapter override > `@db.table` > `@db.view` > interface id).                                                                                                                                                       |
| `schema: string \| undefined`                         | From `@db.schema`.                                                                                                                                                                                                                         |
| `primaryKeys: readonly string[]`                      | PK field names (multiple = composite).                                                                                                                                                                                                     |
| `preferredId: readonly string[]`                      | Preferred row identifier (logical field names). Equals `primaryKeys` unless `@db.table.preferredId.uniqueIndex` is set on the interface. See [actions.md § Preferred row identifier](actions.md#preferred-row-identifier).                 |
| `indexes: Map<name, TDbIndex>`                        | Resolved index definitions.                                                                                                                                                                                                                |
| `relations: Map<name, TDbRelation>`                   | Nav relations.                                                                                                                                                                                                                             |
| `foreignKeys: Map<key, TDbForeignKey>`                | Resolved FK constraints.                                                                                                                                                                                                                   |
| `flatMap: Map<path, type>`                            | All fields as dot-notation paths.                                                                                                                                                                                                          |
| `columnMap: Map<logical, physical>`                   | From `@db.column`.                                                                                                                                                                                                                         |
| `navFields: ReadonlySet<string>`                      | Fields that are `@db.rel.to/.from/.via`.                                                                                                                                                                                                   |
| `relatedTable(navField)`                              | Target table of a nav relation from the same `DbSpace` (since 0.1.134) — read its `primaryKeys` / `preferredId`. `undefined` for non-relations, dotted paths, or no `DbSpace`. Use it instead of reaching into protected `_tableResolver`. |
| `identifications` / `identificationsVisibleTo(pred?)` | Legitimate id shapes (PK + unique indexes); the second drops unique indexes over fields failing `pred` (PK / `preferredId` / `@meta.id` kept, since 0.1.134). See `crud.md` § Deletes.                                                     |
| `dbAdapter / getAdapter()`                            | Underlying adapter instance.                                                                                                                                                                                                               |
| `setVerbose(bool)`                                    | Toggles DB debug logging (zero cost when disabled).                                                                                                                                                                                        |
| `findOne(q) / findMany(q) / count(q)`                 | Read ops (signatures in `crud.md`).                                                                                                                                                                                                        |
| `findManyWithCount(q)`                                | `{ data, count }`. Adapter may collapse to one query.                                                                                                                                                                                      |
| `aggregate(q)`                                        | Group-by aggregation. Distinct method — takes `AggregateQuery`, not `Uniquery`. See [aggregation.md](aggregation.md).                                                                                                                      |
| `search(text, q?, indexName?)`                        | Full-text search. Throws if adapter lacks support.                                                                                                                                                                                         |
| `searchWithCount(text, q?, indexName?)`               | `{ data, count }` variant.                                                                                                                                                                                                                 |
| `vectorSearch(vector, q?, indexName?)`                | Vector similarity search. Throws if adapter lacks support.                                                                                                                                                                                 |
| `vectorSearchWithCount(vector, q?, …)`                | `{ data, count }` variant.                                                                                                                                                                                                                 |
| `isSearchable() / isVectorSearchable()`               | Adapter-capability probes (guard before calling search). `isSearchable()` counts TEXT indexes only — a table whose only search declaration is `@db.search.vector` reports `false` (since 0.1.131).                                         |
| `getSearchIndexes()`                                  | `TSearchIndexInfo[]` — declared search indexes resolved from annotations.                                                                                                                                                                  |

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

| Member                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isView: true`                 | Differentiator from tables. Adapters branch on THIS (or `isAtscriptDbView(readable)`, exported from `@atscript/db`, 0.1.128) — never `instanceof AtscriptDbView` (two copies of the core in a bundle ⇒ false ⇒ an empty table is created under the view's name).                                                                                                                                                                    |
| `viewPlan`                     | Computed plan (entry table + joins + filter + groupBy).                                                                                                                                                                                                                                                                                                                                                                             |
| `isExternal`                   | True when neither `@db.view.for` nor joins are present — assumed pre-existing in DB.                                                                                                                                                                                                                                                                                                                                                |
| `getViewColumnMappings()`      | View column → source table/column; `@db.ignore` fields are excluded (0.1.128) so they never reach `CREATE VIEW`. Names are PHYSICAL on both sides (`viewColumn` = the view's own column, `sourceColumn` = flattened `__` / `@db.column` / document path; `viewPath` = logical view path, required; `json` set for a JSON leaf; `nullable` when the source may be missing — left join, optional, JSON leaf). Computed once per view. |
| `resolveRefSource(ref)`        | A view query ref (join condition, filter, conditional aggregate) → `{ table, source }`: the PHYSICAL column / document path on this view's adapter (+ `jsonPath` inside a JSON column), same layout rules as `TableMetadata`. The only public view-source resolver — use it in custom adapters instead of re-deriving names.                                                                                                        |
| `findOne/Many/count/aggregate` | Read-only ops; writes throw.                                                                                                                                                                                                                                                                                                                                                                                                        |

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

View field refs keep the SOURCE column for the DB layer (`id: Task.id` reads `tasks.id`); over HTTP, `/meta` resolves a chained ref to its terminal field (a view's `assigneeId: Task.assigneeId` → `User.id` with `db.rel.FK` inherited, since 0.1.128) so value-help works on view fields — see `relations.md § Meta FK ref shape`. `@db.ignore`d view fields have no column: excluded from `CREATE VIEW`, from the definition hash and from queries (400); JSON-source paths are not queryable (400) — except a primitive leaf exposed as its own view field (`theme?: User.settings.theme`; see § JSON leaf fields).

### Join rules (0.1.136)

| #   | Rule                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Joins are INNER by default on every adapter; 3rd arg `'left'` keeps unmatched entry rows: ``@db.view.joins User, `User.id = Task.assigneeId`, 'left'``.                                                                                         |
| 2   | A field read from a left-joined table MUST be optional (`assigneeName?: User.name`) — compile error otherwise. `@db.agg.count` / `countDistinct` fields exempt; `sum`/`avg`/`min`/`max` not.                                                    |
| 3   | Joins apply in declaration order; a join condition may reference the entry table + joins declared BEFORE it (chains `Order → Customer → Region`). Forward refs = compile error.                                                                 |
| 4   | One join per table; joining the entry table or the same table twice = compile error (no aliases / self-joins).                                                                                                                                  |
| 5   | `@db.view.filter` on a left-joined table's field drops unmatched rows (acts inner) — put match restrictions into the join condition.                                                                                                            |
| 6   | View predicates support `= != < <= > >= in, not in, exists, not exists, and/or/not`. `matches` fails sync on SQL (and in Mongo join conditions). JSON paths in conditions fail sync.                                                            |
| 7   | Object view field over a flattened source → one view column per leaf; over a `@db.json` source → needs `@db.json` on the view field (sync error otherwise). A chain into a JSON field must end at a string/number/boolean leaf (compile error). |
| 8   | A view field / join / filter ref to a SOURCE field with `@db.ignore` or to a nav relation fails sync (`… has no column — "x" is @db.ignore or a navigation relation`).                                                                          |

### JSON leaf fields (0.1.136)

`theme?: User.settings.theme` where `settings` is `@db.json` → a typed view column; filter / sort / `$groupBy` it like any column.

| #   | Rule                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Leaf must be `string` / `number` / `boolean` (compile error otherwise). Declare the view field optional — it is `null` for a missing key, SQL `NULL` column, JSON `null`, or a value of ANOTHER JSON type. |
| 2   | No coercion: `"14"` is not a number, `1` is not `true`. Numbers are doubles (ints > 2^53 lose precision).                                                                                                  |
| 3   | Usable as SELECT column, GROUP BY dimension, `@db.agg.*` source (`@db.agg.sum "settings.score"`), `@db.view.having` operand. NOT in join ON / `@db.view.filter` (sync error).                              |
| 4   | Computed per row — no index; filters/sorts on it scan the source. Need speed → promote the leaf to a real column.                                                                                          |
| 5   | MongoDB: reads the document path with NO type guard (off-type values written outside atscript-db pass through). SQL adapters guard with `json_type` / `JSON_TYPE` / `jsonb_typeof`.                        |
| 6   | A path segment containing `"`, `\` or a control char fails sync (`JSON path segment … can't be extracted`).                                                                                                |
| 7   | Custom SQL adapters: implement `SqlDialect.jsonExtract` → `creating-adapters.md § SQL helpers`.                                                                                                            |

Sync detail: a view's definition = entry table + joins WITH their ON conditions and kind + each column's physical source + aggregate + filter + having + materialized flag + fields; a physical table already sitting under a managed view's name is a pre-flight refusal, not a silent skip. See `schema-sync.md § View sync`.

## Aggregate views

Plain (non-aggregated) fields become `GROUP BY` keys automatically; `@db.agg.*` fields are the measures. Do NOT add `@db.column.dimension` here — that annotation marks table fields for runtime `aggregate()`/`$groupBy`, not view definitions:

```atscript
@db.view
@db.view.for Order
@db.view.having `totalRevenue > 100`
interface CategoryStats {
    category: Order.category
    @db.agg.sum 'amount'
    totalRevenue: number
    @db.agg.count
    orderCount: number
}
```

Functions: `sum`, `avg`, `count`, `min`, `max`, `countDistinct`. Any of them takes a 2nd query arg → conditional aggregate (``@db.agg.sum "amount", `status = 'paid'` ``; `COUNT(*)` spelled ``@db.agg.count '*', `…` ``). Rules (NULL results, optional fields, scope) → [annotations.md § Aggregation](annotations.md#aggregation-view-fields).

## Lifecycle

| Op                               | Triggers                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `db.getTable(T)` first call      | Adapter factory → `new AtscriptDbTable(...)` → `adapter.registerReadable(readable)`.           |
| `table.ensureTable()`            | Creates the physical table/collection if missing. Idempotent.                                  |
| `table.syncIndexes()`            | Diffs declared indexes vs existing (filtered by `atscript__` prefix) and applies changes.      |
| `syncSchema(space, types, opts)` | Locks → ensures tables → applies column/index/FK diff → stores snapshot. See `schema-sync.md`. |

Tables are created once per type within a `DbSpace`; dropping and re-creating a `DbSpace` is the only way to replace an adapter factory.
