# creating-adapters

Third-party adapters extend `BaseDbAdapter`. Reuse `@atscript/db-sql-tools` for SQL dialects. **Do not import another in-tree adapter.**

## Minimal contract

```ts
import {
  BaseDbAdapter,
  type DbQuery,
  type FilterExpr,
  type TDbInsertResult,
  type TDbInsertManyResult,
  type TDbUpdateResult,
  type TDbDeleteResult,
} from "@atscript/db";

export class MyAdapter extends BaseDbAdapter {
  constructor(private readonly driver: MyDriver) {
    super();
  }

  // ── Required CRUD ──
  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    /* ... */
  }
  async insertMany(rows: Record<string, unknown>[]): Promise<TDbInsertManyResult> {
    /* ... */
  }
  async replaceOne(f: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    /* ... */
  }
  async updateOne(f: FilterExpr, data: Record<string, unknown>, ops?): Promise<TDbUpdateResult> {
    /* ... */
  }
  async deleteOne(f: FilterExpr): Promise<TDbDeleteResult> {
    /* ... */
  }
  async findOne(q: DbQuery): Promise<Record<string, unknown> | null> {
    /* ... */
  }
  async findMany(q: DbQuery): Promise<Record<string, unknown>[]> {
    /* ... */
  }
  async count(q: DbQuery): Promise<number> {
    /* ... */
  }
  async updateMany(f: FilterExpr, data, ops?): Promise<TDbUpdateResult> {
    /* ... */
  }
  async replaceMany(f: FilterExpr, data): Promise<TDbUpdateResult> {
    /* ... */
  }
  async deleteMany(f: FilterExpr): Promise<TDbDeleteResult> {
    /* ... */
  }

  // ── Required schema ──
  async syncIndexes(): Promise<void> {
    /* ... */
  }
  async ensureTable(opts?: TEnsureTableOptions): Promise<void> {
    // Branch on this._table.isView (or isAtscriptDbView) — NEVER instanceof AtscriptDbView.
    // Omit inline FKs whose target is in opts?.deferForeignKeysTo (FK cycles, 0.1.128).
  }
}
```

## Access to metadata

`this._table` (set by `registerReadable()`) exposes everything the adapter needs:

```ts
this._table.tableName;
this._table.schema;
this._table.primaryKeys;
this._table.columnMap; // logical → physical
this._table.flatMap; // all fields as dot-paths
this._table.indexes;
this._table.foreignKeys;
this._table.relations;
this._table.defaults;
this._table.ignoredFields;
this._table.isView;
this._table.fieldDescriptors; // pre-built TDbFieldMeta[]
```

## Overridable flags

| Method / property                  | Default                 | Override when…                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supportsNativePatch()`            | `false`                 | You can translate patches directly (e.g. Mongo `$set` pipeline).                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `nativePatch(filter, patch, ops?)` | throws                  | Implement when `supportsNativePatch()` returns `true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `supportsNestedObjects()`          | `false`                 | Document stores — the generic layer then skips flattening.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `supportsNativeValueDefaults()`    | `false`                 | DEPRECATED 0.1.128 — no longer consulted (static defaults are filled SDK-side on every adapter; SQL DDL emits `DEFAULT` regardless).                                                                                                                                                                                                                                                                                                                                                                      |
| `nativeDefaultFns()`               | `{}`                    | Set of function defaults the DB handles (`'now'`, `'uuid'`, `'increment'`).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `supportsNativeForeignKeys()`      | `false`                 | DB enforces FKs. When `false`, the generic layer runs cascade/setNull.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `supportsNativeRelations()`        | `false`                 | Implement `loadRelations()` for JOIN/`$lookup`-based loading.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `supportsColumnModify`             | `false`                 | Engine supports `ALTER COLUMN` type changes in place (MySQL, PG).                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `canFilterField(fd)`               | `fd.storage !== 'json'` | Adapter natively filters into JSON storage (Mongo dot-paths, arrays). Used by `/meta` `fields[*].filterable` AND by the core path guard (`guardPaths`, since 0.1.128) — a `false` rejects value comparisons with `INVALID_QUERY` before translation. Since 0.1.132 NOT consulted for a sole `$exists: <boolean>` entry (or `$geoWithin`): your translator receives `$exists` on JSON columns and must answer "holds a value" (`IS [NOT] NULL`; document stores `$ne: null` / `null`, never key presence). |
| `canSortField(fd)`                 | `fd.storage !== 'json'` | Also vetoes `designType 'json' \| 'array'` and `encrypted` / `isGeoPoint` (since 0.1.128). Used by `/meta` `fields[*].sortable` AND by the core path guard — adapters may assume every `$sort` key they receive passed it.                                                                                                                                                                                                                                                                                |
| `calendarBucketUnits()`            | empty `Set`             | You group by calendar buckets (since 0.1.132) — return the `BucketUnit`s you implement (`ALL_BUCKET_UNITS` from `@atscript/db` for all five). Empty → core throws `BUCKET_NOT_SUPPORTED` before `aggregate()`, `/meta` has no `bucketUnits`/`bucketable`. moost-db re-reads it (and `isGeoSearchable()`) and rebuilds its capability index when the answer changes.                                                                                                                                       |

Query-guard helpers exported from `@atscript/db` (for custom gates / tooling that must agree with the core): `canFilterLeaf(fd, predicate, adapter)` — `adapter` = anything with `canFilterField(fd)` + `isGeoSearchable()`; `exists` → any non-encrypted leaf, `geo` → `db.geoPoint` on a geo-searchable adapter, `compare` → `canFilterField`; `narrowerFilterOps(fd, adapter)` → the non-compare operators a leaf accepts (`/meta` `filterOps` source); `acceptedOperatorsHint(ops)` → the ` (accepted operators: …)` rejection suffix; types `TFilterPredicate`, `TFilterRef`. BREAKING since 0.1.132: `collectQueryPaths(q).filter` is `TFilterRef[]` (`{ path, predicate }`, one per occurrence) — the old `filter: string[]` + `geoFilter` split is gone.

## Grouped queries / calendar buckets (`aggregate()`)

| #   | Rule                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `aggregate(query)` default throws. Input is translated (physical names): `controls.$groupBy: string[]`, `controls.$select: UniquSelect` → `.asArray` (plain), `.aggregates`, `.buckets` (`TResolvedBucket[]`). Return physical rows; aliases top-level; the table reverse-maps.                                                 |
| 2   | Output key = `resolveAlias(expr)` from `@atscript/db/agg` (`count(*)` → `count_star` since 0.1.132; was `count_*`).                                                                                                                                                                                                             |
| 3   | Portable semantics: `null` + missing = ONE group; `count(f)` non-null; `sum`/`avg` skip nulls → `null` when none; `$count` → `[{ count }]` of groups after `$having`.                                                                                                                                                           |
| 4   | Entries you receive are already validated: the table's query methods reject anything but string / aggregate / bucket `$select` entries with `INVALID_QUERY` `Unsupported $select entry at index i` (since 0.1.132) before translation. `UniquSelect` itself does not validate — don't rely on it if you construct one directly. |
| 5   | Buckets: a `$groupBy` / `$sort` / `$having` key equal to a bucket alias IS that bucket → `controls.$select.bucketByAlias(key)`. `TResolvedBucket` = `alias`, `field` (physical column / doc path), `unit`, `tz` (canonical, validated), `weekStart`, `weekStartIso` (1=Mon…7=Sun), `fd`.                                        |
| 6   | Label contract: `YYYY-MM-DD` of the bucket's first local day in `tz`; `null` for null / missing / non-numeric / outside `[BUCKET_MIN_INSTANT, BUCKET_MAX_INSTANT)`. In-process: `bucketer(unit, tz, weekStart)` from `@uniqu/core`.                                                                                             |
| 7   | Engine can't resolve a zone → throw `bucketTimeZoneUnavailable(message)` from `@atscript/db` (`BUCKET_TZ_UNAVAILABLE`, path `$select`, moost-db 501). Never return NULL / UTC labels silently.                                                                                                                                  |
| 8   | Custom gates / tooling: `resolveCalendarBuckets(controls, fields, aggregate?)` (throws `INVALID_QUERY`), `isBucketableField(fd)`, `isJsonValueField(fd)`, `jsonValueAncestor(path, jsonValueParents)` from `@atscript/db`.                                                                                                      |

Contract for integrators → [calendar-buckets.md](calendar-buckets.md), [aggregation.md](aggregation.md).

## Adapter hooks (optional)

| Hook                                | When called                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `onBeforeFlatten(type)`             | Before flattening — extract table-level annotations.                                       |
| `onFieldScanned(field, type, meta)` | Once per field — extract field-level annotations.                                          |
| `getMetadataOverrides(meta)`        | After scan, before descriptors — adjust PKs, inject fields, add unique constraints.        |
| `onAfterFlatten()`                  | After scan — finalize adapter-specific state.                                              |
| `getAdapterTableName(type)`         | Override table-name source (e.g. `@db.mongo.collection`).                                  |
| `getTopLevelArrayTag()`             | Adapter-specific top-level-array tag name.                                                 |
| `afterSyncTable()`                  | After a table's columns + indexes + FKs synced.                                            |
| `typeMapper(field)`                 | Map field → native column type string (enables column-type diffing).                       |
| `formatValue(field)`                | Return a `toStorage` / `fromStorage` pair for the field (e.g. epoch ms ↔ datetime string). |

## Transactions

Override three primitives; the generic layer handles `AsyncLocalStorage` nesting:

```ts
protected async _beginTransaction(): Promise<unknown> { /* return opaque state */ }
protected async _commitTransaction(state: unknown): Promise<void> { /* ... */ }
protected async _rollbackTransaction(state: unknown): Promise<void> { /* ... */ }
```

Adapters using session-style APIs (MongoDB) can override `withTransaction()` directly and use `_runInTransactionContext(state, fn)` to propagate the session.

## Schema sync hooks (all optional)

| Method                                                                                                                  | Purpose                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getExistingColumns?()`                                                                                                 | Introspect columns for diffing.                                                                                                                                                                                                                      |
| `tableExists?()`                                                                                                        | Used when `getExistingColumns` isn't implemented (Mongo).                                                                                                                                                                                            |
| `getExistingColumnsForTable?(name)`                                                                                     | Introspect a table under its pre-rename name.                                                                                                                                                                                                        |
| `syncColumns?(diff)`                                                                                                    | Execute the diff (`added`, `dropped`, `typeChanged`, `renamed`).                                                                                                                                                                                     |
| `renameTable?(oldName)`                                                                                                 | Handle `@db.table.renamed`.                                                                                                                                                                                                                          |
| `dropTable?()` / `dropColumns?([…])`                                                                                    | Destructive ops (skipped in `safe` mode).                                                                                                                                                                                                            |
| `dropIndexesForColumns?([…])`                                                                                           | Drop managed indexes referencing the columns; called BEFORE `dropColumns` (engines like SQLite refuse `DROP COLUMN` under a live index).                                                                                                             |
| `prepareTypeMapper?()`                                                                                                  | Resolve lazily-detected state `typeMapper` depends on (e.g. vector support) — called before hashing; output must be stable hash-time vs DDL-time.                                                                                                    |
| `recreateTable?()`                                                                                                      | Optional hook used by `@db.sync.method 'recreate'`.                                                                                                                                                                                                  |
| `syncForeignKeys?()`                                                                                                    | FK sync; called after column sync (deferred to a later pass for FK-cycle members).                                                                                                                                                                   |
| `dropForeignKeys?(fkFieldKeys)`                                                                                         | Drop stale FKs blocking `ALTER COLUMN`; also called on a CHILD right before its parent's primary-key rebuild.                                                                                                                                        |
| `getDesiredTableOptions?()` / `getExistingTableOptions?()` / `applyTableOptions?(changes)` / `destructiveOptionKeys?()` | Table-level options (engine/charset/capped).                                                                                                                                                                                                         |
| `hasRows(tableName?)` (0.1.128)                                                                                         | Base default: `count() > 0` for the own table, `undefined` ("cannot tell" → the PK change is refused) for any other name. Override with an `EXISTS`/`LIMIT 1` probe that accepts a name (`tableName` = old name of a pending rename).                |
| `getReferencingForeignKeys?(tableName)` (0.1.128)                                                                       | Live INBOUND FKs `{ table, fields, targetFields }[]` from any table (incl. unmanaged) — drop ordering, surviving-reference checks, PK-change guard. Omit on engines without physical FKs.                                                            |
| `getObjectKind?(name)` (0.1.128)                                                                                        | `'table' \| 'view' \| 'materialized' \| undefined` — table-vs-view name collision refusal; existence of FK targets outside the inventory.                                                                                                            |
| `rebuildPrimaryKey?(change)` (0.1.128)                                                                                  | `{ from, to }` physical columns; empty table only; after adds, before drops; ONE atomic statement where possible. Fallback: `recreateTable()`.                                                                                                       |
| `dropTablesByName(names)` (0.1.128)                                                                                     | Concrete base default loops `dropTableByName`; override for one-statement group drops (PG `DROP TABLE a, b`) or FK-check toggling (SQLite PRAGMA). NEVER `CASCADE` in sync-owned drops — let the engine refuse; sync turns it into an `error` entry. |
| `renderDesiredColumn?(index, field)` (option of `syncIndexesWithDiff`, 0.1.128)                                         | Render a desired key part the way `listExisting` renders live ones (MySQL prefixes) so definition drift compares like with like.                                                                                                                     |

## Index sync helper

Reuse the template method. `prefix` defaults to `'atscript__'` — omit unless overriding.

```ts
async syncIndexes(): Promise<void> {
  await this.syncIndexesWithDiff({
    listExisting: async () => this.driver.all(`PRAGMA index_list(${this._table.tableName})`),
    createIndex:  async (ix) => this.driver.exec(buildCreateIndex(ix)),
    dropIndex:    async (name) => this.driver.exec(`DROP INDEX ${name}`),
    // shouldSkipType: (t) => t === 'vector', // only when a type needs adapter-specific DDL
  })
}
```

Use `shouldSkipType` only for index types your adapter creates outside the standard `CREATE INDEX` path (e.g., a custom virtual table). Don't skip `'fulltext'` on SQLite/MySQL — both build it natively through this helper.

## SQL helpers (`@atscript/db-sql-tools`)

| Export                                                                   | Purpose                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SqlDialect` (type)                                                      | Identifier quoting, boolean / bind placeholders.                                                                                                                                                                                                               |
| `TSqlFragment` (type)                                                    | `{ sql, params }` fragment shape.                                                                                                                                                                                                                              |
| `buildSelect` / `buildInsert` / `buildUpdate` / `buildDelete`            | Dialect-parameterized CRUD SQL builders. `buildInsertMany(dialect, table, rows, columns?)` (since 0.1.132): multi-row insert over the column union (`insertManyColumns(rows)`), `DEFAULT` for missing columns — never take columns from row 1 only.            |
| `buildProjection`                                                        | Projection clause for `SELECT`.                                                                                                                                                                                                                                |
| `buildCreateView`                                                        | View DDL builder.                                                                                                                                                                                                                                              |
| `buildAggregateSelect` / `buildAggregateCount`                           | `GROUP BY` / `HAVING` SQL for `@db.agg.*`.                                                                                                                                                                                                                     |
| `AGG_FN_SQL`                                                             | Map of aggregate function → SQL name.                                                                                                                                                                                                                          |
| `createFilterVisitor(dialect)`                                           | MongoDB-shape filter → SQL `WHERE` + bind array (visitor for `@uniqu/core` `walkFilter`).                                                                                                                                                                      |
| `buildWhere`                                                             | `WHERE` clause builder for a parsed filter.                                                                                                                                                                                                                    |
| `queryOpToSql` / `queryNodeToSql`                                        | Translate query AST nodes.                                                                                                                                                                                                                                     |
| `buildGeoSearchSelect` / `buildGeoSearchCount`                           | Distance-ranked geo search SQL (subquery + `__atscript_distance` alias + window/paging).                                                                                                                                                                       |
| `renameGeoDistance` / `geoWindowFromControls` / `normalizeGeoPointValue` | Geo post-fetch `$distance` rename, `$maxDistance`/`$minDistance` extraction, tuple/JSON-string normalize.                                                                                                                                                      |
| `SqlDialect.geoWithin?(col, circle)`                                     | Optional dialect hook for `$geoWithin`; absent → visitor throws `GEO_NOT_SUPPORTED`.                                                                                                                                                                           |
| `SqlDialect.calendarBucket?(quotedCol, b)`                               | Calendar-bucket label expression (TEXT `YYYY-MM-DD` / NULL). MUST be parameter-free (rendered in SELECT, GROUP BY, HAVING; PG matches GROUP BY structurally) — inline the zone via `sqlTimeZoneLiteral(b.tz)`. Absent → builders throw `BUCKET_NOT_SUPPORTED`. |
| `SqlDialect.bucketAliasInHaving?`                                        | `true` = HAVING references a bucket by its SELECT alias (MySQL); default re-renders the expression (PG rejects aliases in HAVING).                                                                                                                             |
| `groupKeySql(dialect, controls, key)` / `sqlTimeZoneLiteral(tz)`         | Render a `$groupBy` key (bucket alias → expression, else quoted column) / quote a validated zone (charset re-checked).                                                                                                                                         |
| `parseRegexString`                                                       | Parse `/pattern/flags` strings for `$regex`.                                                                                                                                                                                                                   |
| `defaultValueForType`                                                    | Type-driven default literal for SQL DDL.                                                                                                                                                                                                                       |
| `defaultValueToSqlLiteral`                                               | `@db.default.value` → SQL literal.                                                                                                                                                                                                                             |
| `refActionToSql`                                                         | `@db.rel.onDelete/onUpdate` → `ON DELETE …` clause.                                                                                                                                                                                                            |
| `sqlStringLiteral`                                                       | Escape a JS string into a SQL string literal.                                                                                                                                                                                                                  |
| `toSqlValue`                                                             | Coerce JS value for bind/embed.                                                                                                                                                                                                                                |
| `EMPTY_AND` / `EMPTY_OR`                                                 | Identity fragments for empty boolean groups.                                                                                                                                                                                                                   |
| `finalizeParams`                                                         | Renumber bind placeholders for the dialect (e.g. `?` → `$1`).                                                                                                                                                                                                  |

Implement a `SqlDialect` for your engine, then delegate to the shared builders. **Do not hand-roll filter translation.**

## Optional runtime hooks

- **`prepareId(id, fieldType)`** — transform an inbound ID before driver calls. Override when the storage type differs from the wire type (Mongo: `string` → `ObjectId`; SQL adapters: identity). Used by `findOne`/`insertOne`/`updateOne`/`deleteOne` whenever the PK is hit by value.
- **`logger` + `_log(...args)`** — `BaseDbAdapter.logger` is set via `registerReadable()` from the table's logger; call `this._log(sql, params)` before every driver call. Defaults to `NoopLogger`. Adapter authors gate verbose logs on `this._verboseLog`.
- **Constraint-error translation** — wrap each write with an adapter-private helper (e.g. `_wrapConstraintError(fn)` in PostgresAdapter) that catches DB-native error codes (Postgres: `23505` → `CONFLICT`, `23503` → `FK_VIOLATION`) and rethrows as `DbError` from `@atscript/db`. Codes: `CONFLICT` | `FK_VIOLATION` | `NOT_FOUND` | `CASCADE_CYCLE` | `INVALID_QUERY` | `DEPTH_EXCEEDED`. `moost-db` maps `DbError` to the right HTTP status — every adapter MUST surface its constraint errors as `DbError`.

## Validator plugins

Return adapter-specific validators from `getValidatorPlugins(): TValidatorPlugin[]`. Example (Mongo): `validateMongoIdPlugin` rejects malformed ObjectId strings at the validator stage.

## Third-party adapter checklist

- `extends BaseDbAdapter`.
- Implements all abstract methods.
- Detects views with `this._table.isView` / `isAtscriptDbView()` — never `instanceof AtscriptDbView`.
- Implements `hasRows(tableName?)` (an `EXISTS` probe that accepts a table name) if it implements column introspection — the base default is a `count()` (a full scan on most engines) and answers "cannot tell" for a renamed table.
- `syncIndexesWithDiff({...})` in `syncIndexes()` for uniform index naming.
- Exports a `createAdapter(connection, options?)` one-liner that returns a `DbSpace`.
- Does **not** import another adapter package.
- Reuses `@atscript/db-sql-tools` (if SQL) for builders and filter translation.
- Translates `$exists` as "holds a value" on EVERY column kind, JSON included (`null` ≡ missing ≡ absent).
- Publishes a plugin (`TAtscriptPlugin`) that registers annotations + primitives consumers write in `.as`.
