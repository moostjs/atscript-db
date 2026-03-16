---
outline: deep
---

# Creating Custom Adapters

<!--@include: ../_experimental-warning.md-->

You can create adapters for any database by extending `BaseDbAdapter` from `@atscript/db`. This guide covers the full interface — every abstract method you must implement, every optional hook you can override, and how your adapter plugs into the rest of the system.

## Architecture

Your adapter sits between the table API and the database:

```
AtscriptDbTable → BaseDbAdapter (your adapter) → Database
```

The table handles query translation, field flattening, relation orchestration, validation, and default values. Your adapter handles raw CRUD operations and DDL — it receives pre-processed data and query objects, and returns results in a standard format.

When an `AtscriptDbTable` is created with your adapter, it registers itself via `registerReadable()`. From that point, you can access all computed table metadata through `this._table`.

## Getting Started

Extend `BaseDbAdapter` and implement the abstract methods:

```typescript
import { BaseDbAdapter } from "@atscript/db";

export class PostgresAdapter extends BaseDbAdapter {
  constructor(private pool: Pool) {
    super();
  }

  // implement abstract methods (see below)
}
```

Each adapter instance is bound to a single table or view. The `DbSpace` factory creates one instance per table, keeping adapter state (cached queries, table metadata) isolated.

## Required Methods

These are abstract — every adapter must implement all of them.

### Insert

- **`insertOne(data)`** — Insert a single record. Returns `TDbInsertResult` with `{ insertedId }`.
- **`insertMany(data)`** — Insert multiple records. Returns `TDbInsertManyResult` with `{ insertedCount, insertedIds }`.

Data is already validated, defaults applied, and columns mapped by the table layer. Your adapter only needs to translate to the database's native insert syntax.

::: tip
Use `this._resolveInsertedId(data, dbGeneratedId)` in your `insertOne` implementation to return the correct inserted ID. It prefers the user-supplied primary key value from the data over the DB-generated fallback (e.g., `RETURNING id`, `lastInsertRowid`).
:::

### Read

- **`findOne(query)`** — Find a single record matching the query. Returns the record or `null`. The `query` object contains `filter` (WHERE conditions) and `controls` (sort, limit, skip, select).
- **`findMany(query)`** — Find all records matching the query. Returns an array of records.
- **`count(query)`** — Count records matching the query filter. Returns a number.

### Update

- **`updateOne(filter, data)`** — Update a single record matching the filter. Returns `TDbUpdateResult` with `{ matchedCount, modifiedCount }`.
- **`updateMany(filter, data)`** — Update all records matching the filter.
- **`replaceOne(filter, data)`** — Full replacement of a single record (all columns overwritten).
- **`replaceMany(filter, data)`** — Full replacement of all matching records.

### Delete

- **`deleteOne(filter)`** — Delete a single record matching the filter. Returns `TDbDeleteResult` with `{ deletedCount }`.
- **`deleteMany(filter)`** — Delete all records matching the filter.

### Schema

- **`ensureTable()`** — Create the table/collection if it does not exist. Use `this._table.tableName`, `this._table.fieldDescriptors`, and `this._table.foreignKeys` to build the DDL.
- **`syncIndexes()`** — Synchronize indexes between Atscript definitions and the database. Use `this._table.indexes` for the desired index state.

::: tip
Data passed to insert/update/replace methods is **already processed** by the table layer — defaults applied, `@db.ignore` fields stripped, column names mapped. Your adapter only needs to translate to the database's native query language.
:::

## Capability Flags

Override these methods to declare what your database supports. All return `false` by default. The generic DB layer reads these flags and adapts its behavior automatically.

### `supportsNativePatch()`

Return `true` if your database handles array patch operators natively (e.g., MongoDB's `$push`, `$pull`). When `false`, the table layer decomposes patch operations into read-modify-write cycles using standard `updateOne`.

### `supportsNestedObjects()`

Return `true` if your database stores nested objects natively (e.g., MongoDB embedded documents). When `true`, the table layer skips flattening and passes nested objects as-is. When `false`, nested objects are flattened to `__`-separated column names (e.g., `address__city`).

### `supportsNativeForeignKeys()`

Return `true` if your database enforces FK constraints at the engine level (e.g., SQLite with `PRAGMA foreign_keys = ON`, PostgreSQL). When `true`, the table layer skips application-level cascade/setNull logic on delete. When `false`, the table layer handles cascade by finding and deleting/nullifying child records before the parent.

### `supportsNativeRelations()`

Return `true` to handle `$with` relation loading natively via database features like SQL JOINs or MongoDB `$lookup`. When `false`, the table layer uses application-level batch loading — issuing separate queries per relation and stitching results together.

### `supportsNativeValueDefaults()`

Return `true` if the database handles static `@db.default "value"` natively via column-level `DEFAULT` clauses in `CREATE TABLE`. When `true`, the table layer's `_applyDefaults()` skips client-side value defaults, letting the DB apply its own DEFAULT. SQL adapters typically return `true`; document stores (MongoDB) return `false`.

### `nativeDefaultFns()`

Return a `ReadonlySet<TDbDefaultFn>` of default function names that the database handles natively. Fields with these defaults are omitted from INSERT when no value is provided, letting the DB apply its own DEFAULT expression (e.g., `CURRENT_TIMESTAMP`, `gen_random_uuid()`).

```typescript
nativeDefaultFns(): ReadonlySet<TDbDefaultFn> {
  return new Set(['now', 'uuid'])  // DB handles NOW() and UUID() natively
}
```

The generic layer checks this in `_applyDefaults()` to decide whether to generate the value client-side or leave it for the DB.

### `supportsColumnModify`

This is a **property** (not a method). Set to `true` if the adapter can handle column type changes in-place via `ALTER TABLE MODIFY COLUMN` (e.g., MySQL, PostgreSQL) without requiring table recreation. The generic sync layer will delegate type changes to `syncColumns()` instead of requiring `@db.sync.method "recreate"` or `"drop"`.

```typescript
supportsColumnModify = true;
```

## Transaction Support

Override three protected methods to enable transactions:

```typescript
protected async _beginTransaction(): Promise<unknown> {
  // Start a transaction, return opaque state (e.g., a session or client object)
  const client = await this.pool.connect()
  await client.query('BEGIN')
  return client
}

protected async _commitTransaction(state: unknown): Promise<void> {
  const client = state as PoolClient
  await client.query('COMMIT')
  client.release()
}

protected async _rollbackTransaction(state: unknown): Promise<void> {
  const client = state as PoolClient
  await client.query('ROLLBACK')
  client.release()
}
```

The `state` value you return from `_beginTransaction` is passed to commit and rollback. Use it to carry database-specific context (e.g., a MongoDB `ClientSession`, a dedicated connection from a pool).

Transaction context is tracked via `AsyncLocalStorage` — nested `withTransaction()` calls within the same async chain automatically reuse the existing transaction. Inside any method, call `this._getTransactionState()` to retrieve the current transaction state.

### Advanced: Custom Transaction Flow

If your database has a specialized transaction API (e.g., MongoDB's `session.withTransaction()`), override `withTransaction()` directly and use `_runInTransactionContext(state, fn)` to set up the shared context. This ensures that nested adapters within the same async chain see the same transaction state. If a context already exists (nesting), it is reused.

## Adapter Hooks

These optional methods are called during table initialization when the table scans its type metadata.

### `onBeforeFlatten(type)`

Called before field scanning begins. Use this to extract table-level adapter-specific annotations.

```typescript
onBeforeFlatten(type: TAtscriptAnnotatedType): void {
  // Example: read a table-level annotation
  const engine = type.metadata?.get('db.mysql.engine')
  if (engine) this.tableEngine = engine as string
}
```

### `onFieldScanned(field, type, metadata)`

Called for each field during the scanning process. Fields nested under navigation relations (`@db.rel.to/from/via`) are never delivered to this callback — adapters do not need to filter them.

```typescript
onFieldScanned(
  field: string,
  type: TAtscriptAnnotatedType,
  metadata: TMetadataMap
): void {
  // Example: register vector search fields
  const vector = metadata.get('db.search.vector')
  if (vector) this.vectorFields.set(field, vector)
}
```

### `onAfterFlatten()`

Called after all fields are scanned. Finalize any computed state here. You can access the fully populated `this._table` at this point.

```typescript
onAfterFlatten(): void {
  // Example: build search index configuration from collected fields
  this.searchConfig = buildSearchConfig(this.textFields, this.vectorFields)
}
```

### `getAdapterTableName(type)`

Return an adapter-specific table name, or `undefined` to fall back to `@db.table` or the interface name.

```typescript
getAdapterTableName(type: TAtscriptAnnotatedType): string | undefined {
  // Example: read from a custom annotation
  return type.metadata?.get('db.postgres.table') as string | undefined
}
```

### `getMetadataOverrides()`

Return metadata overrides applied during the build pipeline. Called after field scanning/classification, before field descriptors are built. Use this to adjust primary keys, inject synthetic fields, or register unique constraints — instead of mutating metadata via back-references.

```typescript
getMetadataOverrides(meta: TableMetadata): TMetadataOverrides | undefined {
  // Example: MongoDB always uses _id as primary key
  return {
    primaryKeys: new Set(['_id']),
  }
}
```

## ID Preparation

Override `prepareId(id, fieldType)` to transform primary key values before they are used in queries. This is called when building filters for `findById`, relation loading, and other ID-based lookups.

```typescript
prepareId(id: unknown, fieldType: TAtscriptAnnotatedType): unknown {
  // Example: convert string IDs to MongoDB ObjectId
  return new ObjectId(id as string)
}
```

The default implementation returns `id` unchanged.

## Native Operations

### Native Patch

If `supportsNativePatch()` returns `true`, implement `nativePatch(filter, patch)`. Convert patch operators (e.g., `{ $push: { tags: 'new' } }`) to your database's native update operations and return `TDbUpdateResult` with `{ matchedCount, modifiedCount }`. When `supportsNativePatch()` returns `false` (the default), the table layer decomposes patch operations into read-modify-write cycles.

### Native Relation Loading

If `supportsNativeRelations()` returns `true`, implement `loadRelations(rows, withRelations, relations, foreignKeys, tableResolver?)`. Enrich the provided rows in place with related data using your database's native features (e.g., MongoDB `$lookup`, SQL JOINs). When `supportsNativeRelations()` returns `false` (the default), the table layer handles relation loading by issuing separate queries per relation.

## Schema Sync Methods

These optional methods enable the schema sync system (`asc db sync`) to introspect, diff, and apply changes to your database. Implement them if you want automatic schema migration support.

### Introspection

#### `getExistingColumns()`

Return the current table structure as an array of `TExistingColumn` (name, type, nullability, default, PK status). The sync system diffs these against the current Atscript field descriptors to determine what has changed. Query `information_schema.columns` or your database's equivalent to build the result.

#### `getExistingColumnsForTable(tableName)`

Same as `getExistingColumns()` but for an arbitrary table name (not the adapter's own table). Used by schema sync's `plan()` to inspect a table under its old name before a rename operation.

#### `tableExists()`

Return whether the table/collection exists in the database. Used by schema-less adapters (e.g., MongoDB) that skip column introspection. The sync system uses this to determine create vs. in-sync status.

#### `getExistingTableOptions()`

Return the current table-level options from the live database. This is the primary source for option diffing (DB-first strategy). Returns an array of `TExistingTableOption` (key-value pairs) or `undefined` if the adapter cannot introspect table options.

#### `getDesiredTableOptions()`

Return table-level options as declared by Atscript annotations. Called after `onBeforeFlatten`/`onAfterFlatten`, so adapter-specific state (e.g., engine, charset, capped options) is already populated. Values are stringified for consistent comparison against existing options.

#### `destructiveOptionKeys()`

Return a `ReadonlySet<string>` of option keys where a value change requires full table recreation (drop + recreate). Option keys not in this set are treated as non-destructive changes and handled by `applyTableOptions()`.

```typescript
destructiveOptionKeys(): ReadonlySet<string> {
  // Changing the engine requires recreation
  return new Set(['engine'])
}
```

### Applying Changes

#### `syncColumns(diff)`

Apply column-level changes from a computed diff. The diff object contains `added`, `renamed`, and `typeChanged` arrays. Execute `ALTER TABLE ADD COLUMN`, `RENAME COLUMN`, and `ALTER COLUMN TYPE` statements (or equivalent DDL) for each entry. Returns a `TSyncColumnResult` indicating what was applied.

#### `recreateTable()`

Full table recreation with data migration. Used when structural changes cannot be handled by `ALTER TABLE` (e.g., column drops in SQLite, or when `@db.sync.method "recreate"` is specified). Typical pattern: create a temporary table with the new schema, copy data (only columns that exist in both old and new), drop the old table, rename the temp table to the original name.

#### `renameTable(oldName)`

Rename the table from `oldName` to the adapter's current table name. Used when `@db.table.renamed` is present.

#### `afterSyncTable()`

Post-sync hook called after all table operations (columns, indexes, FKs) are complete. Adapters can use this for finalization work such as resetting auto-increment sequences to match existing data.

#### `applyTableOptions(changes)`

Apply non-destructive table option changes. Called for each changed option that is not in `destructiveOptionKeys()`. Destructive changes go through `dropTable()` + `ensureTable()` or `recreateTable()` instead.

### Destructive Operations

#### `dropTable()`

Drop the adapter's own table. Used by `@db.sync.method "drop"` for tables with ephemeral data.

#### `dropTableByName(name)`

Drop a table by name, without needing a registered readable. Used by schema sync to remove tables that are no longer present in the schema.

#### `dropColumns(columns)`

Drop specific columns from the table. Used by schema sync to remove stale columns no longer in the Atscript definitions.

### Views

#### `ensureView(view)`

Create or update a database view. Called when the adapter's readable is an `AtscriptDbView`. The `view` parameter contains the view definition, including the source table, joins, and filter expressions.

#### `dropViewByName(name)`

Drop a view by name. Used by schema sync to remove views that are no longer present in the schema.

### Foreign Keys

#### `syncForeignKeys()`

Synchronize foreign key constraints between Atscript definitions and the database. Uses `this._table.foreignKeys` for the full FK definitions.

#### `dropForeignKeys(fkFieldKeys)`

Drop FK constraints identified by their canonical local column key (sorted local field names, comma-joined). Called by the sync executor before column operations to remove stale FKs that would otherwise block `ALTER COLUMN`.

### Type Mapping

#### `typeMapper(field)`

Map a field's metadata to the adapter's native column type string. Receives the full field descriptor (`TDbFieldMeta` with design type, annotations, PK status, etc.) for context-aware type decisions — e.g., `VARCHAR(255)` from `maxLength`, `SERIAL` for numeric PKs, `JSONB` for `@db.json` fields. Used by schema sync to detect column type changes (comparing the desired type from `typeMapper` against the existing type from `getExistingColumns`).

#### `formatValue(field)`

Return a value formatter for a field, or `undefined` if no formatting is needed. Called once per field during the build phase. The returned formatter(s) are cached and applied during write preparation, filter translation, and read reconstruction.

Can return:

- A bare function: used as `toStorage` only (write + filter paths)
- A `TValueFormatterPair` with `toStorage` and `fromStorage`: bidirectional formatting
- `undefined`: no formatting needed

```typescript
formatValue(field: TDbFieldMeta): TValueFormatterPair | undefined {
  // Example: MySQL TIMESTAMP stored as datetime string, exposed as epoch ms
  if (field.designType === 'date') {
    return {
      toStorage: (v: unknown) => new Date(v as number).toISOString(),
      fromStorage: (v: unknown) => new Date(v as string).getTime(),
    }
  }
  return undefined
}
```

This avoids per-value method dispatch — only fields that need formatting get a formatter function, and the generic layer skips fields without one.

## Index Sync Helper

`BaseDbAdapter` provides `syncIndexesWithDiff()` — a template method that handles the diff algorithm for index synchronization. You provide the three database-specific primitives:

```typescript
async syncIndexes(): Promise<void> {
  await this.syncIndexesWithDiff({
    listExisting: async () => {
      // Return existing indexes as [{ name: string }]
      return this.pool.query(
        'SELECT indexname AS name FROM pg_indexes WHERE tablename = $1',
        [this._table.tableName]
      )
    },
    createIndex: async (index) => {
      // Create a single index — index has key, fields, type ('plain'|'unique')
      const cols = index.fields.map(f => `"${f.name}" ${f.sort}`).join(', ')
      await this.pool.query(
        `CREATE ${index.type === 'unique' ? 'UNIQUE ' : ''}INDEX "${index.key}"
         ON ${this.resolveTableName()} (${cols})`
      )
    },
    dropIndex: async (name) => {
      await this.pool.query(`DROP INDEX "${name}"`)
    },
    // Optional: skip index types your DB doesn't support
    shouldSkipType: (type) => type === 'fulltext',
  })
}
```

The helper:

1. Lists existing indexes via `listExisting`
2. Filters to managed ones (those with the `atscript__` prefix)
3. Creates missing indexes via `createIndex`
4. Drops stale indexes via `dropIndex`

You can override the prefix via the `prefix` option (defaults to `'atscript__'`).

## Search and Vector Search

Override these methods to add text search and vector similarity search capabilities to your adapter.

### Text Search

#### `search(text, query, indexName?)`

Full-text search. Receives the search text, a standard `DbQuery` for additional filtering/pagination, and an optional index name to target a specific search index. Build a search query using your database's text search capabilities (e.g., PostgreSQL `ts_query`, MongoDB `$text`, MySQL `MATCH...AGAINST`).

#### `searchWithCount(text, query, indexName?)`

Same as `search()` but also returns the total count (for paginated search results). Returns `{ data, count }`.

### Vector Search

#### `vectorSearch(vector, query, indexName?)`

Vector similarity search. Receives a pre-computed embedding vector (`number[]`), a standard `DbQuery`, and an optional index name for multi-vector documents. Build a similarity query using your database's vector capabilities (e.g., pgvector `<->` operator, MongoDB `$vectorSearch`).

#### `vectorSearchWithCount(vector, query, indexName?)`

Same as `vectorSearch()` but also returns the total count. Returns `{ data, count }`.

### Search Metadata

#### `isSearchable()`

Whether the adapter supports text search. Defaults to `true` when `getSearchIndexes()` returns any entries. Override for custom logic.

#### `isVectorSearchable()`

Whether the adapter supports vector similarity search. Defaults to `false`. Override in adapters that support vector search.

#### `getSearchIndexes()`

Return available search indexes for this adapter as `TSearchIndexInfo[]`. Used by UI to show an index picker and by the generic layer to validate search requests.

```typescript
getSearchIndexes(): TSearchIndexInfo[] {
  return [
    { name: 'default', type: 'text', fields: ['title', 'body'] },
    { name: 'embedding', type: 'vector', fields: ['embedding'] },
  ]
}
```

## Optimized Pagination

### `findManyWithCount(query)`

Fetches records and total count in one call. The default implementation issues two parallel calls (`findMany` + `count`). Override for single-query optimization if your database supports it (e.g., `COUNT(*) OVER()` window function in PostgreSQL). Returns `{ data, count }`.

## Validation Plugins

Override `getValidatorPlugins()` to return adapter-specific `TValidatorPlugin[]` rules that are merged with the built-in Atscript validators. Each plugin has a `name` and a `validate(value, type, path)` function that can transform values (e.g., auto-generate MongoDB `ObjectId` for `_id` fields) or reject invalid input.

## Accessing Table Metadata

Inside your adapter, `this._table` provides access to all computed metadata:

| Property                           | Description                                              |
| ---------------------------------- | -------------------------------------------------------- |
| `this._table.tableName`            | Resolved table/collection name                           |
| `this._table.schema`               | Database schema (if applicable)                          |
| `this._table.flatMap`              | All fields after flattening (dot-notation paths)         |
| `this._table.primaryKeys`          | Set of primary key field names                           |
| `this._table.columnMap`            | Logical field name to physical column name mappings      |
| `this._table.indexes`              | Computed index definitions from `@db.index` annotations  |
| `this._table.foreignKeys`          | FK definitions from `@db.rel.FK` annotations             |
| `this._table.defaults`             | Default value configurations from `@db.default`          |
| `this._table.fieldDescriptors`     | Full field metadata (type, nullability, PK, storage)     |
| `this._table.ignoredFields`        | Fields excluded from the database via `@db.ignore`       |
| `this._table.uniqueProps`          | Single-field unique index properties                     |
| `this._table.isView`               | Whether this readable is a view (vs a table)             |
| `this._table.originalMetaIdFields` | Fields annotated with `@meta.id` (before column mapping) |

The `resolveTableName()` method on the adapter itself returns the full table name, optionally including the schema prefix. Override it for databases that don't support schemas:

```typescript
override resolveTableName(): string {
  return super.resolveTableName(false) // exclude schema prefix
}
```

### Logging

The adapter includes a built-in logging facility. Call `this._log(...)` to emit debug-level messages when verbose mode is enabled. Verbose mode is toggled via `setVerbose(enabled)`. When disabled, no log strings are constructed — zero overhead.

## Registration

Use your adapter with `DbSpace` to create tables:

```typescript
import { DbSpace } from "@atscript/db";

const db = new DbSpace(() => new PostgresAdapter(pool));

// Create typed tables
const users = db.getTable(UsersType);
const posts = db.getTable(PostsType);

// Tables share the adapter factory — each gets its own instance
await users.ensureTable();
await posts.ensureTable();
```

`DbSpace` calls your factory function for each table, so every table gets its own adapter instance. This keeps adapter state (table metadata, cached queries) isolated per table.

## Next Steps

- [PostgreSQL](./postgresql) — reference implementation for a full-featured SQL adapter
- [MongoDB](./mongodb) — advanced implementation with native nested objects, patch operators, and search
- [Schema Sync](../sync/) — how the sync system uses adapter methods to manage migrations
