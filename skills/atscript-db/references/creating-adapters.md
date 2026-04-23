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
  async ensureTable(): Promise<void> {
    /* ... */
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

| Method / property                  | Default | Override when…                                                                      |
| ---------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `supportsNativePatch()`            | `false` | You can translate patches directly (e.g. Mongo `$set` pipeline).                    |
| `nativePatch(filter, patch, ops?)` | throws  | Implement when `supportsNativePatch()` returns `true`.                              |
| `supportsNestedObjects()`          | `false` | Document stores — the generic layer then skips flattening.                          |
| `supportsNativeValueDefaults()`    | `false` | SQL engines with `DEFAULT` clauses. Set `true` to let the DB apply static defaults. |
| `nativeDefaultFns()`               | `{}`    | Set of function defaults the DB handles (`'now'`, `'uuid'`, `'increment'`).         |
| `supportsNativeForeignKeys()`      | `false` | DB enforces FKs. When `false`, the generic layer runs cascade/setNull.              |
| `supportsNativeRelations()`        | `false` | Implement `loadRelations()` for JOIN/`$lookup`-based loading.                       |
| `supportsColumnModify`             | `false` | Engine supports `ALTER COLUMN` type changes in place (MySQL, PG).                   |

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

## Schema sync hooks

| Method                                                                                                              | Purpose                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `getExistingColumns()`                                                                                              | Introspect columns for diffing.                                  |
| `tableExists()`                                                                                                     | Used when `getExistingColumns` isn't implemented (Mongo).        |
| `getExistingColumnsForTable(name)`                                                                                  | Introspect a table under its pre-rename name.                    |
| `syncColumns(diff)`                                                                                                 | Execute the diff (`added`, `dropped`, `typeChanged`, `renamed`). |
| `renameTable(oldName)`                                                                                              | Handle `@db.table.renamed`.                                      |
| `dropTable()` / `dropColumns([…])`                                                                                  | Destructive ops (skipped in `safe` mode).                        |
| `recreateTable()`                                                                                                   | Used by `@db.sync.method 'recreate'`.                            |
| `syncForeignKeys()`                                                                                                 | Implement FK sync; called after column sync.                     |
| `dropForeignKeys(fkFieldKeys)`                                                                                      | Drop stale FKs blocking `ALTER COLUMN`.                          |
| `getDesiredTableOptions()` / `getExistingTableOptions()` / `applyTableOptions(changes)` / `destructiveOptionKeys()` | Table-level options (engine/charset/capped).                     |

## Index sync helper

Reuse the template method:

```ts
async syncIndexes(): Promise<void> {
  await this.syncIndexesWithDiff({
    listExisting: async () => this.driver.all(`PRAGMA index_list(${this._table.tableName})`),
    createIndex:  async (ix) => this.driver.exec(buildCreateIndex(ix)),
    dropIndex:    async (name) => this.driver.exec(`DROP INDEX ${name}`),
    prefix: 'atscript__',
    shouldSkipType: (t) => t === 'fulltext',      // handle separately if needed
  })
}
```

## SQL helpers

`@atscript/db-sql-tools` provides:

- `SqlDialect` interface — identifier quoting, boolean/bind-placeholder conventions.
- `buildSelect/Insert/Update/Delete` — dialect-parameterized builders.
- `createFilterVisitor(dialect, ctx)` — MongoDB-shape filter → SQL `WHERE` + bind array.
- `buildAggregate` — `GROUP BY`/`HAVING` with `@db.agg.*`.

Implement a `SqlDialect` for your engine, then delegate to the shared builders. **Do not hand-roll filter translation.**

## Validator plugins

Return adapter-specific validators from `getValidatorPlugins(): TValidatorPlugin[]`. Example (Mongo): `validateMongoIdPlugin` rejects malformed ObjectId strings at the validator stage.

## Third-party adapter checklist

- `extends BaseDbAdapter`.
- Implements all abstract methods.
- `syncIndexesWithDiff({...})` in `syncIndexes()` for uniform index naming.
- Exports a `createAdapter(connection, options?)` one-liner that returns a `DbSpace`.
- Does **not** import another adapter package.
- Reuses `@atscript/db-sql-tools` (if SQL) for builders and filter translation.
- Publishes a plugin (`TAtscriptPlugin`) that registers annotations + primitives consumers write in `.as`.
