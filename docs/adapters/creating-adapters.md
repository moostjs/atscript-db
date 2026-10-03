---
outline: deep
---

# Creating Custom Adapters

<!--@include: ../_experimental-warning.md-->

::: warning Advanced / contributor reference
This page is for authors writing a **new** Atscript DB adapter for a database that does not have one yet. If you are building an application on top of an existing adapter (PostgreSQL, SQLite, MongoDB, MySQL), **you do not need this page** — start with the relevant adapter page and the [CRUD docs](/api/crud) instead.

The interfaces and hooks documented below are not part of the consumer-facing public API: they are stable enough to write adapters against, but they describe how to extend the generic layer, not how to use it.
:::

You can create adapters for any database by extending `BaseDbAdapter` from `@atscript/db`. This guide covers the full interface — every abstract method you must implement, every optional hook you can override, and how your adapter plugs into the rest of the system.

## Architecture

Your adapter sits between the table API and the database:

```
AtscriptDbTable → BaseDbAdapter (your adapter) → Database
```

The table handles query translation, field flattening, relation orchestration, validation, and default values. Your adapter handles raw CRUD operations and DDL — it receives pre-processed data and query objects, and returns results in a standard format.

When an `AtscriptDbTable` is created with your adapter, it registers itself via `registerReadable()`. From that point, you can access all computed table metadata through `this._table`.

#### `registerSpace(space)` — since 0.1.137 {#register-space}

A `DbSpace` calls it on every adapter its factory builds — the administrative adapter it drops tables through included — before `registerReadable()`. The default does nothing. Override it to share state across a space's adapters when there is no driver to share it through: the memory adapter keeps one store per space, keyed by the `space` object.

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

::: warning Constraint errors must be `DbError`s
Wrap every write (insert, update, replace, patch, delete) so that a native constraint error is rethrown as `DbError` from `@atscript/db`: a duplicate primary or unique key as `DbError("CONFLICT")`, a foreign-key violation as `DbError("FK_VIOLATION")`. moost-db maps them to 409 / 400, and schema sync relies on `CONFLICT` to recognise a lock held by another pod — a raw driver error there makes `run()` reject when two pods start together (since 0.1.141).
:::

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

#### Versioned tables {#versioned-tables}

When the table declares [`@db.column.version`](/api/versioning), `this._table.versionColumnPhysical` names its stored column (`undefined` otherwise). The table layer has already removed `$cas` from the payload and rejected direct writes to the version field, so `data` never contains it. The adapter:

- **bumps** it by 1 in every `updateOne`, `updateMany`, `replaceOne` and `replaceMany`, in the same statement as the write;
- **compares** it when `updateOne(filter, data, ops, expectedVersion)` or `replaceOne(filter, data, expectedVersion)` receives an `expectedVersion`: add `<column> = expectedVersion` to the match, so a stale version matches nothing and returns `{ matchedCount: 0, modifiedCount: 0 }`;
- **defaults** it to `0` on insert when the engine has no DDL `DEFAULT` for it (document stores).

Use `versionColumnPhysical`, not `versionColumn`: `versionColumn` is the field name clients use in `$cas` and write bodies, and it differs from the stored column under a `@db.column` rename (since 0.1.141). SQL adapters get the bump and the comparison from `buildUpdate` in `@atscript/db-sql-tools` (pass it `versionColumnPhysical` and `expectedVersion`), the insert default from the `DEFAULT 0` that schema sync declares, and should pass `versionColumnPhysical` to `fillReplacePayload` so a full replace never resets the column.

### Delete

- **`deleteOne(filter)`** — Delete a single record matching the filter. Returns `TDbDeleteResult` with `{ deletedCount }`.
- **`deleteMany(filter)`** — Delete all records matching the filter.

### Schema

- **`ensureTable(opts?)`** — Create the table/collection if it does not exist. Use `this._table.tableName`, `this._table.fieldDescriptors`, and `this._table.foreignKeys` to build the DDL — name FK columns by each FK's `physicalFields` / `physicalTargetFields` (since 0.1.147; `fields` / `targetFields` are the logical names and differ under `@db.column`). Branch on **`this._table.isView`** (or the exported `isAtscriptDbView()` guard) to create a view — never `instanceof AtscriptDbView`: a bundle can carry two copies of `@atscript/db`, and a false `instanceof` would create an empty physical table under the view's name. If your engine emits inline `FOREIGN KEY` constraints, omit those whose target is in `opts.deferForeignKeysTo` (since 0.1.128 — schema sync creates a foreign-key cycle that way and adds the constraints through `syncForeignKeys()` once every member exists).
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

### `supportsRelationFilters(mode)` — since 0.1.147 {#supports-relation-filters}

Return `true` to receive [relational predicates](/api/queries#relational-filters) (`$some` / `$none`) in `mode`: `'read'` for the filters of find, count, search and `aggregate()`, `'write'` for mutation filters (`updateMany`, `replaceMany`, `deleteMany`, row scopes). Default `false`: the core rejects such a filter with `REL_FILTER_NOT_SUPPORTED` (`… in mutation filters` for writes) before your adapter sees it. All bundled adapters return `true` for both modes. What you receive is described in [Relational Predicates](#relational-predicates).

### `supportsNativeValueDefaults()` (deprecated)

Deprecated since 0.1.128 and no longer consulted by the generic layer: static `@db.default "value"` values are filled SDK-side on every adapter before validation (so validators and write guards see the full row), and the SQL adapters emit their DDL `DEFAULT` clauses regardless of this flag. The built-in SQL adapters still return `true` as a capability hint for tooling; a new adapter can leave the default `false`.

### `nativeDefaultFns()`

Return a `ReadonlySet<TDbDefaultFn>` of default function names that the database handles natively. Fields with these defaults are omitted from INSERT when no value is provided, letting the DB apply its own DEFAULT expression (e.g., `CURRENT_TIMESTAMP`, `gen_random_uuid()`).

```typescript
nativeDefaultFns(): ReadonlySet<TDbDefaultFn> {
  return new Set(['now', 'uuid'])  // DB handles NOW() and UUID() natively
}
```

The generic layer checks this in its defaults pass to decide whether to generate the value client-side or leave it for the DB.

### `supportsColumnModify`

This is a **property** (not a method). Set to `true` if the adapter can handle column type changes in-place via `ALTER TABLE MODIFY COLUMN` (e.g., MySQL, PostgreSQL) without requiring table recreation. The generic sync layer will delegate type changes to `syncColumns()` instead of requiring `@db.sync.method "recreate"` or `"drop"`.

```typescript
supportsColumnModify = true;
```

### `canFilterField(fd)` / `canSortField(fd)`

Per-field vetoes consulted by the core query guard (every read, `aggregate()`, `updateMany` / `deleteMany`) and by moost-db's `/meta.fields` + request gate — a `false` rejects the path with `INVALID_QUERY` before your translator runs. Defaults: `canFilterField` returns `false` for JSON-stored columns (`fd.storage === 'json'`) and encrypted fields; `canSortField` also vetoes `@db.json` / array design types and `geoPoint`. Override `canFilterField` when your engine can compare inside JSON storage (MongoDB and the memory adapter return `!fd.encrypted`).

`canFilterField` vetoes **value comparison** only. Since 0.1.132 an entry whose sole operator is `$exists: <boolean>` is accepted on any stored, non-encrypted column regardless of it, so your filter translator must handle `$exists` on JSON columns too, with the portable ["holds a value"](/api/queries#existence) meaning: `null` and missing are both absent (SQL `IS [NOT] NULL`; for a document store, `$ne: null` / `null` rather than key presence). A `$geoWithin` entry likewise bypasses it and is validated against `isGeoSearchable()` instead.

`@atscript/db` exports the same rule for custom gates and tooling: `canFilterLeaf(fd, predicate, adapter)` answers whether a leaf accepts a filter entry of class `predicate` (`TFilterPredicate`: `'compare' | 'exists' | 'geo'`) — `adapter` is anything with `canFilterField(fd)` and `isGeoSearchable()` (an adapter or a readable); `geo` needs a `db.geoPoint` leaf on a geo-searchable adapter. `narrowerFilterOps(fd, adapter)` lists the operators of the non-compare classes a leaf accepts (what `/meta` reports as `filterOps`), and `acceptedOperatorsHint(ops)` renders the ` (accepted operators: …)` suffix used in rejections. `collectQueryPaths(query)` returns `filter` as `{ path, predicate }` entries, one per occurrence (since 0.1.132 — it previously returned `filter: string[]` plus a separate `geoFilter` list).

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

A native loader must apply the relation's [`@db.rel.filter`](/relations/navigation#db-rel-filter) (since 0.1.147 the generic loader does): `relationStaticFilter(relation)` from `@atscript/db` returns it as logical filters split by side, `{ target?, junction? }` — AND `target` into the related rows and, on a `via` relation, `junction` into the junction rows. A `null` foreign key loads nothing (`null` / `[]`), even where the engine considers `null` equal to `null`.

## Relational Predicates {#relational-predicates}

Since 0.1.147. When [`supportsRelationFilters(mode)`](#supports-relation-filters) returns `true`, a filter reaching your adapter may hold `{ <nav>: { $some | $none: <operand> } }`. The core has already guarded it (limits, the related table's field rules) and resolved it: the operand is a `ResolvedRelationFilter` with physical names on every side. Your adapter only renders it.

`walkFilter` from `@uniqu/core` hands such an entry to the visitor's `relation(field, op, operand)` callback and does not recurse into the operand. A visitor without `relation` throws when it meets one, so **every `walkFilter` visitor that can see a translated filter must implement it** — the WHERE renderer, but also any visitor you use for counts, deletes or search filters.

| `ResolvedRelationFilter` member | Content                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`                          | `'to'`, `'from'` or `'via'`                                                                                                                                                                |
| `nav`                           | The logical navigation field (for error paths)                                                                                                                                             |
| `source`, `target`              | `{ table, name, adapter }` — `table` is the adapter's `resolveTableName()` (schema-qualified), `name` the bare table / collection name                                                     |
| `pairs`                         | `to` / `from`: `[{ source, target }]` physical columns, one per key part — a related row has `target.<pair.target> = source.<pair.source>`. Empty for `via`                                |
| `junction`                      | `via` only: `{ table, name, adapter, toSource: [{ junction, source }], toTarget: [{ junction, target }], filter? }` — `filter` is the junction part of `@db.rel.filter`                    |
| `filter`                        | The operand on the target: physical names, value formatters applied, nested predicates resolved the same way, the target part of `@db.rel.filter` ANDed in. `{}` matches every related row |

Render `$some` as "a related row exists" and `$none` as "none exists". A `null` component of the source key relates to nothing — `$some` false, `$none` true — even where the engine compares `null` equal to `null` (MongoDB's aggregation `$eq` does). Render nested predicates inside the operand against the related row, not the outer one.

Helpers exported from `@atscript/db`:

- `isResolvedRelationFilter(value)` — the operand type guard (a `Symbol.for` brand, so it holds across two loaded copies of `@atscript/db`, ESM and CJS).
- `containsRelationPredicate(filter)` — a cheap pre-scan; keep predicate-free filters on your existing fast path.
- `forEachResolvedRelation(filter, visit, nested?)` — visits every resolved predicate of a translated filter (operands and junction filters included), e.g. to load related data before evaluating, or to detect a predicate that reads the table being written.
- `relationStaticFilter(relation)`, `andFilters(...parts)`, `isRelationOp`, `RELATION_OPS`, `REL_FILTER_MAX_DEPTH`, `REL_FILTER_MAX_NODES` (core limits, server predicates included), `REL_FILTER_CLIENT_MAX_DEPTH`, `REL_FILTER_CLIENT_MAX_NODES` (the HTTP client budget).

**Same store.** The core renders a predicate only when the related (and junction) table's adapter `sharesStoreWith` the source's: by default the same adapter class and the same transaction owner (`_transactionOwner()` — see [Transaction Support](#transaction-support); the driver, pool or client) — two connections of one class are different stores. Override it when one owner serves several databases (the MongoDB adapter also compares the database name). Otherwise the predicate is a `REL_FILTER_NOT_SUPPORTED`.

**SQL adapters on `@atscript/db-sql-tools`** get the rendering from `createFilterVisitor` / `buildWhere`: a correlated `EXISTS (SELECT 1 FROM <target> AS "_rf1" WHERE "_rf1"."<col>" = <outer>."<col>" …)`, `NOT EXISTS` for `$none`, a junction `JOIN` for `via`; parameters keep their textual order, so `finalizeParams` numbering is unaffected. The outer columns are qualified with the source table's name, which is right whenever the statement's FROM is the bare table. **A statement that aliases its FROM must pass the quoted alias** as `qualifier` in `TFilterVisitorOptions`; an unqualified or wrongly qualified outer column would bind to the subquery's table:

```typescript
// SELECT … FROM "items" AS "t" WHERE …
const where = buildWhere(dialect, filter, {
  columnRef: (column) => `"t".${dialect.quoteIdentifier(column)}`,
  qualifier: '"t"',
});
```

A write whose predicate reads the table being written may need engine-specific handling (MySQL rejects it with error 1093 — see [MySQL § Relational predicates](./mysql#relational-predicates)). A document store without correlated subqueries can resolve the matching ids first and write by id, as the [MongoDB adapter](./mongodb#relational-predicates) does.

## Schema Sync Methods

These optional methods enable the schema sync system (`asc db sync`) to introspect, diff, and apply changes to your database. Implement them if you want automatic schema migration support.

### Introspection

#### `getExistingColumns()`

Return the current table structure as an array of `TExistingColumn` (name, type, nullability, default, PK status). The sync system diffs these against the current Atscript field descriptors to determine what has changed. Query `information_schema.columns` or your database's equivalent to build the result. Flag a generated column with `generated: true` (since 0.1.141) — see [Derived columns](#derived-columns).

#### `getExistingColumnsForTable(tableName)`

Same as `getExistingColumns()` but for an arbitrary table name (not the adapter's own table). Used by schema sync's `plan()` to inspect a table under its old name before a rename operation.

#### `tableExists()`

Return whether the table/collection exists in the database. Used by schema-less adapters (e.g., MongoDB) that skip column introspection. The sync system uses this to determine create vs. in-sync status.

#### `getExistingTableOptions(tableName?)`

Return the current table-level options from the live database. This is the primary source for option diffing (DB-first strategy). Returns an array of `TExistingTableOption` (key-value pairs) or `undefined` if the adapter cannot introspect table options. `tableName` (since 0.1.128) is the OLD name of a table about to be renamed — schema sync introspects a pending `@db.table.renamed` table under that name, as it does with `getExistingColumnsForTable()`; default to the adapter's own table when it is omitted.

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

#### `hasRows(tableName?)` — since 0.1.128

Whether the table has at least one row (`SELECT EXISTS`/`LIMIT 1`, not a count). Schema sync uses it in its pre-flight phase to refuse a primary-key change on a populated table; `tableName` is the OLD name of a table about to be renamed. The base class provides a default — `count() > 0` for the adapter's own table, a full scan on some engines — that returns `undefined` ("cannot tell") for any other `tableName`, which schema sync turns into a refusal asking for an override. Override it with a probe that accepts a table name.

#### `getReferencingForeignKeys(tableName)` — since 0.1.128

Live foreign keys that **reference** `tableName` from any table in the database, as `{ table, fields, targetFields }[]` — including tables whose models are no longer in the inventory. Schema sync uses it to drop removed tables children-first, to refuse dropping a table an unmanaged table still references, and to refuse a primary-key change a live constraint depends on. Omit it on engines without physical foreign keys.

#### `getObjectKind(name)` — since 0.1.128 {#getobjectkind-name}

`'table' | 'view' | 'materialized' | undefined` for the object stored under `name`. Schema sync refuses a run when a physical table sits where a managed view is declared (or a view where a table is declared), and uses it to check whether an FK target outside the inventory exists at all. Adapters without it skip the check.

### Applying Changes

#### `syncColumns(diff)`

Apply column-level changes from a computed diff. The diff object contains `added`, `renamed`, and `typeChanged` arrays. Execute `ALTER TABLE ADD COLUMN`, `RENAME COLUMN`, and `ALTER COLUMN TYPE` statements (or equivalent DDL) for each entry. Returns a `TSyncColumnResult` indicating what was applied.

#### `recreateTable()`

Full table recreation with data migration. Used when structural changes cannot be handled by `ALTER TABLE` (e.g., column drops in SQLite, or when `@db.sync.method "recreate"` is specified). Typical pattern: create a temporary table with the new schema, copy data (only columns of `this._table.storedDescriptors` that exist in both old and new — never a generated column), drop the old table, rename the temp table to the original name. Run it in a transaction where the engine's DDL is transactional. Where DDL auto-commits (MySQL), drop the temp table when a step fails before the original is gone; after that the temp table holds the only copy of the rows, so keep it and name it in the error.

#### `renameTable(oldName)`

Rename the table from `oldName` to the adapter's current table name. Used when `@db.table.renamed` is present.

#### `afterSyncTable()`

Post-sync hook called after all table operations (columns, indexes, FKs) are complete. Adapters can use this for finalization work such as resetting auto-increment sequences to match existing data.

#### `applyTableOptions(changes)`

Apply non-destructive table option changes. Called for each changed option that is not in `destructiveOptionKeys()`. Destructive changes go through `dropTable()` + `ensureTable()` or `recreateTable()` instead.

#### `rebuildPrimaryKey(change)` — since 0.1.128

Rewrite the table's primary key from `change.from` to `change.to` (physical column names). Called only on an **empty** table, after new columns were added and before stale ones are dropped, so both column sets exist. Adapters without it fall back to `recreateTable()`. Keep it to one atomic statement where the engine allows (MySQL `ALTER TABLE … DROP PRIMARY KEY, ADD PRIMARY KEY (…)`, PostgreSQL `DROP CONSTRAINT …, ADD PRIMARY KEY (…)`).

### Destructive Operations

Sync-owned drops must **never cascade**: if something outside the inventory depends on the table, fail — schema sync turns the failure into an `error` entry and keeps the table tracked.

#### `dropTable()`

Drop the adapter's own table. Used by `@db.sync.method "drop"` for tables with ephemeral data.

#### `dropTableByName(name)`

Drop a table by name, without needing a registered readable. Used by schema sync to remove tables that are no longer present in the schema. A missing table is not an error. The base class throws `… is not supported by this adapter` (since 0.1.137 — see [Upgrading](/guide/upgrading#v0-1-137)); schema sync then reports every removed table as an `error` entry and keeps it tracked.

#### `dropTablesByName(names)` — since 0.1.128

Drop a group of mutually referencing tables (a foreign-key cycle whose members are all being removed) as one operation. The base class loops over `dropTableByName()`; override when your engine needs the group in one statement (PostgreSQL `DROP TABLE a, b`) or FK enforcement toggled around it (SQLite `PRAGMA foreign_keys`).

#### `dropColumns(columns)`

Drop specific columns from the table. Used by schema sync to remove stale columns no longer in the Atscript definitions.

#### `dropIndexesForColumns(columns)`

Drop managed (`atscript__`-prefixed) indexes that reference any of the given columns. Called by schema sync **before** `dropColumns` — engines like SQLite refuse to drop a column while an index still references it, and a composite index that survives by name must be rebuilt without the removed column (`syncIndexes` recreates it afterwards). Implement this if your engine does not cascade index drops on `DROP COLUMN`.

### Views

#### `ensureView(view)`

Create or update a database view. Called when the adapter's readable is a view — detect that structurally with `this._table.isView` / `isAtscriptDbView(this._table)`, never with `instanceof AtscriptDbView` (see [Schema](#schema)). The `view` parameter contains the view definition, including the source table, joins, and filter expressions; `view.getViewColumnMappings()` already excludes `@db.ignore` fields.

Since 0.1.141 an entry or join source may be another view (render it like a table), and a join is addressed by its `scope`: the physical `targetTable`, or the alias name of a [`@db.alias` join](/views/#join-aliases-and-self-joins). When the two differ, alias the physical source under the scope name (`LEFT JOIN "employees" AS "Manager"`) — conditions, filters and `resolveRefSource(ref).table` use the scope name. The `@atscript/db-sql-tools` view builder does this for you.

#### `dropViewByName(name)`

Drop a view by name. Used by schema sync to remove views that are no longer present in the schema, and to drop a managed view before recreating it. A missing view is not an error. The base class throws, like `dropTableByName()`, and sync reports the view as an `error` entry.

#### `viewRenderRevision()` — since 0.1.137 {#view-render-revision}

```typescript
viewRenderRevision(): string | undefined
```

Schema sync recreates a managed view only when its definition changes, so a fix to how your adapter renders views would never reach views created before it. Return a revision string and bump it in the release that changes what an existing view returns: the revision is part of every managed view's sync snapshot, so each managed view of your adapter is recreated once (`plan()` reports it as `alter`) on the first sync after the upgrade. External views are never affected. The default `undefined` adds nothing to the snapshot — view hashes stay as they were. The MongoDB adapter returns `"2"` since 0.1.137.

```typescript
class MyAdapter extends BaseDbAdapter {
  // Bump when ensureView() renders an unchanged view differently
  override viewRenderRevision(): string {
    return "2";
  }
}
```

#### `viewCapabilities()` — since 0.1.147 {#view-capabilities}

```typescript
viewCapabilities(): ReadonlySet<"compute" | "firstJoin">
```

The managed-view features `ensureView()` renders: `compute` — [computed columns](/views/computed-columns) (`TViewColumnMapping.expr`); `firstJoin` — [first-row joins](/views/#first-row-joins) (`TViewJoin.first`). Schema sync refuses a view that uses a feature missing from the set (`… is not supported by this adapter (viewCapabilities())`). A direct `ensureTable()` call for such a view throws the same message before your `ensureTable()` runs: `BaseDbAdapter` wraps it when it is bound to a managed view, so you do not need your own check. The default is **empty** — fail-closed, so an adapter written before these features never receives a view it would render wrong (a renderer that ignored `TViewJoin.first` would produce a plain, row-multiplying join). Return `ALL_VIEW_CAPABILITIES` (from `@atscript/db`) once you render both:

- **Computed column** — a mapping with `expr` reads no source column (`sourceColumn` is `""`); its leaves name other columns of the same view by `viewPath` (computed leaves included — inline them). Evaluate in IEEE double, `NULL` for a `NULL` operand, `NULL` for division by zero. Keep computed columns out of `GROUP BY`. A `@db.view.having` ref may name one: render its expression there, not the SELECT alias, because MySQL binds a bare HAVING name that matches a `GROUP BY` column to that column. `walkViewExpr(expr, leaf)` (from `@atscript/db`) visits the leaves.
- **First-row join** — of the target rows matching `condition`, join only the first by `first.order` (keys qualified with the target, the primary key `first.key` already appended). `NULL` is the smallest value (first in `asc`).

SQL adapters on `@atscript/db-sql-tools` get both from the view builder once the dialect implements `castDouble` ([below](#calendar-buckets)).

```typescript
import { ALL_VIEW_CAPABILITIES, BaseDbAdapter } from "@atscript/db";

class MyAdapter extends BaseDbAdapter {
  override viewCapabilities() {
    return ALL_VIEW_CAPABILITIES;
  }
}
```

### Derived columns {#derived-columns}

A [`@db.column.derived`](/api/storage#derived-columns) field (since 0.1.141, `field.derived` set on its descriptor) needs work only on SQL adapters. On an adapter whose `supportsNestedObjects()` is `true` the core maps the field to its source path and leaves it out of `columnDescriptors`, so nothing reaches the adapter.

- **DDL** — in `ensureTable()` and for the `added` entries of `syncColumns()`, render the field as a generated column over `derivedColumnExpr(dialect, field)` (from `@atscript/db-sql-tools`), without `NOT NULL` or `DEFAULT`. The expression calls your dialect's `jsonExtract` hook ([below](#calendar-buckets)), which becomes required.
- **Introspection** — `getExistingColumns()` returns `generated: true` for generated columns.
- **Changes** — a derived column never appears in `typeChanged`, `nullableChanged` or `defaultChanged`. Any drift is a `derivedChanged` entry that schema sync applies itself as `dropIndexesForColumns()` → `dropColumns()` → `syncColumns({ added })`.
- **Writes** — the core drops derived values from every write payload; `recreateTable()` copies `storedDescriptors`, which leave them out.

### Foreign Keys

#### `syncForeignKeys()`

Synchronize foreign key constraints between Atscript definitions and the database. Uses `this._table.foreignKeys` for the full FK definitions; compare and create constraints on the physical columns (`physicalFields` / `physicalTargetFields`, since 0.1.147).

#### `dropForeignKeys(fkFieldKeys)`

Drop FK constraints identified by their canonical local column key (sorted physical local column names, comma-joined). Called by the sync executor before column operations to remove stale FKs that would otherwise block `ALTER COLUMN`.

### Type Mapping

#### `typeMapper(field)`

Map a field's metadata to the adapter's native column type string. Receives the full field descriptor (`TDbFieldMeta` with design type, annotations, PK status, etc.) for context-aware type decisions — e.g., `VARCHAR(255)` from `maxLength`, `SERIAL` for numeric PKs, `JSONB` for `@db.json` fields. Used by schema sync to detect column type changes (comparing the desired type from `typeMapper` against the existing type from `getExistingColumns`).

#### `prepareTypeMapper()`

Resolve any runtime state `typeMapper` depends on — e.g. detecting whether a vector extension is installed. Schema sync calls this **before** hashing the desired schema. The contract: `typeMapper` must return the same string at hash time and at DDL time; if its output can change based on lazily-detected capabilities, perform that detection here, or the stored hash will never match and sync will re-run on every boot.

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
      // Return existing indexes as [{ name: string, columns?: string[] }].
      // Include the ordered column list so the helper can detect definition
      // drift (e.g. a composite index that gained a member keeps its name).
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
4. Rebuilds plain/unique indexes whose column list no longer matches the model (only when `listExisting` provides `columns`)
5. Drops stale indexes via `dropIndex`

You can override the prefix via the `prefix` option (defaults to `'atscript__'`).

## Grouped Queries {#grouped-queries}

### `aggregate(query)`

```typescript
aggregate(query: DbQuery): Promise<Array<Record<string, unknown>>>
```

Override to support [grouped queries](/api/aggregation); the default throws. The table validates the query, maps logical names to physical ones, and hands you a `DbQuery` whose `controls.$groupBy` is a `string[]` and whose `controls.$select` is a `UniquSelect`: `asArray` lists the plain grouped fields, `aggregates` the `{ $fn, $field, $as? }` entries, `buckets` the calendar buckets. Since 0.1.132 `UniquSelect` rejects any other `$select` entry when it is constructed (`INVALID_QUERY`, `Unsupported $select entry at index i`), so your translator only ever sees those three kinds.

Return one row per group, with physical names for grouped fields and each computed entry under its output key — `resolveAlias(expr)` from `@atscript/db/agg` (`$as`, else `{fn}_{field}`; `count(*)` → `count_star` since 0.1.132, `count_*` before). The table reverse-maps the rows. Match the portable semantics: `null` and missing values form one group, `count(field)` counts non-null values, `sum` / `avg` ignore nulls. `$count: true` returns `[{ count: N }]`, the number of groups that survive `$having`. SQL adapters get all of this from `buildAggregateSelect` / `buildAggregateCount` in `@atscript/db-sql-tools`. Before rendering a `$fn`, re-assert it with `assertAggregateFn(fn)` from `@atscript/db/agg` (since 0.1.135).

### Aggregate functions {#aggregate-functions}

```typescript
aggregateFns(): ReadonlySet<AggregateFn> // 'sum' | 'count' | 'avg' | 'min' | 'max' | 'countDistinct'
```

The aggregate functions your `aggregate()` renders (since 0.1.136). The default is `sum`, `count`, `avg`, `min` and `max`. The core rejects any other known function [with `AGG_FN_NOT_SUPPORTED`](/api/aggregation#validation-and-errors) before it calls `aggregate()`, so an adapter written before a function existed never receives it. moost-db's [`/meta`](/http/crud#get-meta) advertises the set as `aggregateFns`. The same set gates managed views: schema sync refuses a view whose `@db.agg.*` field uses a function missing from it. Conditional aggregates (the `@db.agg.*` second argument) are not a separate capability — an adapter that renders views renders them.

To support `countDistinct` too, return `ALL_AGGREGATE_FNS` (exported from `@atscript/db`) and follow its semantics: count the **distinct non-null** values of `$field` in each group. `null` and missing values are never counted, a group of only nulls counts `0`, and `'*'` never reaches you (the core rejects `countDistinct(*)`). Distinctness may follow the engine's collation. The value must be a number by the time `$having` and `$sort` see it. For example, MongoDB collects a set with `$addToSet` and turns it into its non-null size before `$having`. SQL adapters built on `buildAggregateSelect` / `buildAggregateCount` render `COUNT(DISTINCT col)` already, in `SELECT` and `HAVING`, and only need to return the set.

```typescript
import { ALL_AGGREGATE_FNS, BaseDbAdapter, type AggregateFn } from "@atscript/db";

class MyAdapter extends BaseDbAdapter {
  override aggregateFns(): ReadonlySet<AggregateFn> {
    return ALL_AGGREGATE_FNS;
  }
}
```

`assertAggregateFn` accepts every known function, `countDistinct` included; its type `TDbAggregateFn` is uniqu's full `AggregateFn`. `AGG_FN_SQL` from `@atscript/db-sql-tools` maps only the single-name functions — `countDistinct` renders as `COUNT(DISTINCT x)`.

### Calendar buckets {#calendar-buckets}

```typescript
calendarBucketUnits(): ReadonlySet<BucketUnit> // 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year'
```

The [calendar-bucket](/api/calendar-buckets) units your adapter can group by (since 0.1.132). Return `ALL_BUCKET_UNITS` (exported from `@atscript/db`) when you implement all six. The default is an empty set: the core then rejects every bucket source with `BUCKET_NOT_SUPPORTED` ([errors](/api/calendar-buckets#errors)) before calling `aggregate()`, and moost-db's `/meta` advertises no `bucketUnits` and no `bucketable` field. moost-db re-reads this method (and `isGeoSearchable()`) when building its capability index, so the answer may change after construction or schema sync.

::: warning Changed in 0.1.147: `ALL_BUCKET_UNITS` grew
`ALL_BUCKET_UNITS` now includes `hour`. An adapter that returns it advertises hourly buckets from 0.1.147 on, so it must render hour labels — or return an explicit set without `hour` (`new Set(BUCKET_UNITS.filter((u) => u !== "hour"))`, `BUCKET_UNITS` from `@uniqu/core`) until it does. `ALL_BUCKET_UNITS` may grow again: return it only if your adapter renders every unit the core knows.
:::

Returning a unit commits `aggregate()` to handle it:

- **Read the buckets from `controls.$select.buckets`** — `TResolvedBucket` entries (exported from `@atscript/db`) carrying `alias`, `field` (the physical column or document path), `unit`, `tz` (a canonical IANA name, already validated), `weekStart` / `weekStartIso` (1 = Monday … 7 = Sunday), and `fd`, the source field's descriptor.
- **Resolve keys by alias.** A `$groupBy`, `$sort` or `$having` key that equals a bucket's alias means that bucket: `controls.$select.bucketByAlias(key)` returns it. Aliases never collide with column names.
- **Produce the label contract.** The value is the `YYYY-MM-DD` local date of the bucket's first day in `tz` — for `hour`, the local wall-clock hour `YYYY-MM-DDTHH:00`, read from the zone's local time (truncating the UTC instant to the hour is wrong for +05:30 or +05:45 zones); `null` for a `null`, missing or non-numeric source and for instants outside `[BUCKET_MIN_INSTANT, BUCKET_MAX_INSTANT)` (exported by `@uniqu/core`). For an in-process implementation, `bucketer(unit, tz, weekStart)` from `@uniqu/core` returns a labelling function — the memory adapter and the SQLite function use it.
- **Never fall back silently.** When the engine cannot resolve a zone, throw `bucketTimeZoneUnavailable(message)` from `@atscript/db` — a `DbError("BUCKET_TZ_UNAVAILABLE")` on path `$select`, HTTP 501 — rather than returning `null` or UTC labels.

For SQL adapters built on `@atscript/db-sql-tools`, implement two optional `SqlDialect` members instead:

- **`calendarBucket?(quotedCol: string, b: TResolvedBucket): string`** — the label expression over one column. It must be **parameter-free**: the builders render it in `SELECT`, `GROUP BY` and `HAVING`, and PostgreSQL matches `GROUP BY` expressions structurally. Inline the zone with `sqlTimeZoneLiteral(b.tz)`, which re-checks the name's charset before quoting it. Handle each unit explicitly and throw on any other — never a catch-all default branch, which would silently mislabel a unit added later. Without this hook the builders throw `BUCKET_NOT_SUPPORTED`.
- **`bucketAliasInHaving?: boolean`** — render a bucket in `HAVING` by its `SELECT` alias instead of repeating the expression. MySQL needs it (it rejects the raw column there but resolves aliases); PostgreSQL needs the default expression form.
- **`jsonExtract?(quotedCol: string, path: readonly string[], type: "string" | "number" | "boolean"): string`** — the typed read of one primitive leaf inside a JSON column, used by [view fields that read a JSON leaf](/views/#reading-json-leaves) (since 0.1.136) and, through `derivedColumnExpr`, by [derived columns](#derived-columns) (since 0.1.141). It must be **parameter-free**, because it runs in `CREATE VIEW` and in column DDL. Return the declared type, or `NULL` when the path is missing, the value is JSON `null`, or the value has another JSON type. Never coerce: the JSON string `"5"` is `NULL` for a `number` leaf. Build the path literal from `quotedJsonPathSegments(path)` (exported from `@atscript/db-sql-tools`), which quotes each segment and rejects segments that can't be quoted portably. Without this hook, syncing a view with a JSON-leaf field fails with `JSON extraction is not supported by this adapter`, and so does syncing a table with a derived column.

- **`castDouble?(expr: string): string`** — `expr` as an IEEE double (SQLite `CAST(x AS REAL)`, MySQL `CAST(x AS DOUBLE)`, PostgreSQL `CAST(x AS DOUBLE PRECISION)`), parameter-free. The view builder casts every operand of a [computed column](/views/computed-columns) with it (since 0.1.147); without it, syncing a view with a computed column fails with `computed view columns are not supported by this adapter`.
- **`nullsSortLargest?: boolean`** — set when the database sorts `NULL` as the largest value (PostgreSQL): first-row join order keys then render `ASC NULLS FIRST` / `DESC NULLS LAST`, keeping `NULL` the smallest value everywhere (since 0.1.147).

`groupKeySql(dialect, controls, key)` renders a `$groupBy` key — the bucket expression for a bucket alias, the quoted column otherwise.

`@atscript/db` also exports the rules the core and moost-db apply, for custom gates and tooling:

- `normalizeComputedSelect(controls, fields, aggregate?)` validates and normalizes the computed `$select` entries of a query — aggregate names and the `'*'` rule, calendar buckets — and returns the buckets (throws `INVALID_QUERY`). `resolveCalendarBuckets` is a deprecated alias.
- `bucketSourceVerdict(fd, table, adapter)` (since 0.1.133) decides whether a field can be a bucket source. It applies every rule from [which fields can be bucketed](/api/calendar-buckets#which-fields-can-be-bucketed) except the HTTP-only `@db.writeOnly` veto, which your gate adds itself. The core guard and moost-db's `/meta` and gate all call it. It returns `{ ok: true }` or `{ ok: false, code, reason }`:
  - `code` is one of `"encrypted"`, `"jsonDescendant"`, `"notTimestamp"`, `"notFilterable"`, `"notDimension"` or `"noBuckets"` — the first rule the field fails.
  - `reason` is the clause the built-in [messages](/api/calendar-buckets#errors) print after the dash, without a trailing period.
  - `table` is the table's `TableMetadata` (`table.getMetadata()`), or any `TBucketSourceTable` with `jsonValueParents`, `dimensions` and `measures`.
  - `adapter` is the adapter, or a readable proxying it (anything with `canFilterField` and `calendarBucketUnits`).
- `isBucketableField(fd)` is deprecated since 0.1.133 — use `bucketSourceVerdict`.
- `isJsonValueField(fd)` tells whether a descriptor holds a JSON value (JSON storage, or a `json` / `array` design type), and `jsonValueAncestor(path, jsonValueParents)` returns the outermost such ancestor (from a set of their paths) that disqualifies a nested path.

For multi-row inserts, `buildInsertMany(dialect, table, rows, columns?)` in `@atscript/db-sql-tools` renders one `INSERT … VALUES (…), (…)` over the union of the rows' columns (`insertManyColumns(rows)`), with `DEFAULT` for a column a row lacks — so a heterogeneous batch stores what the same rows inserted one by one would (since 0.1.132; pass `columns` to keep one column list across your own batches).

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

### Geo Search

#### `geoSearch(point, query, indexName?)` / `geoSearchWithCount(...)`

Distance-ranked geospatial search. Receives a `[lng, lat]` query point; must return rows sorted by distance ascending, each carrying a `$distance` field in meters. `$maxDistance`/`$minDistance` arrive in `query.controls`. The default implementations throw `GEO_NOT_SUPPORTED`. SQL adapters can build the query with the shared helpers from `@atscript/db-sql-tools` (`buildGeoSearchSelect`, `buildGeoSearchCount`, `renameGeoDistance`) plus a dialect-specific distance expression; `_resolveGeoColumn(indexName?)` (protected, on `BaseDbAdapter`) resolves the geo index to its physical column.

#### `isGeoSearchable()`

Whether the adapter supports `geoSearch()` and the `$geoWithin` filter operator. Defaults to `false`. The core query guards consult this before translating `$geoWithin`, so a dialect without a `geoWithin` hook never sees the operator.

#### `SqlDialect.geoWithin(quotedCol, circle)` (db-sql-tools)

Optional dialect hook translating `$geoWithin: { center, radius }` into a SQL predicate fragment. Dialects without it cause the shared filter visitor to throw `GEO_NOT_SUPPORTED` — never a silent scan.

### Search Metadata

#### `isSearchable()`

Whether the adapter can run **text** search. Defaults to `true` when `getSearchIndexes()` returns at least one non-vector entry — see the tagging contract below. Override for custom logic.

#### `isVectorSearchable()`

Whether the adapter supports vector similarity search. Defaults to `false`. Override in adapters that support vector search.

#### `getSearchIndexes()`

Return available search indexes for this adapter as `TSearchIndexInfo[]`. Used by UI to show an index picker and by the generic layer to validate search requests.

```typescript
getSearchIndexes(): TSearchIndexInfo[] {
  return [
    { name: 'default', type: 'text', description: 'tsvector(title, body)',
      fields: ['title', 'body'], isDefault: true },
    { name: 'embedding', type: 'vector', description: 'vector(1536), cosine',
      fields: ['embedding'], isDefault: true },
  ]
}
```

Since 0.1.143 each entry also says which **logical** fields the index reads (`fields`) and whether it is the one of its type that answers a request naming no index (`isDefault`, at most one per type). HTTP layers gate indexes over hidden fields with them — an index whose fields you cannot tell (a dynamic document mapping) leaves `fields` out, which callers treat as "every field". Index definitions carry physical column names; the protected `this._indexLogicalPaths(index)` maps a `TDbIndex` back to logical paths.

Word "index not found" errors with the exported builders — `searchIndexNotFoundMessage(name?)`, `vectorIndexNotFoundMessage(name?)`, `geoIndexNotFoundMessage(table, name?)` — so a request naming a hidden index reads exactly like one naming a nonexistent index.

**Tag every vector entry `type: 'vector'`.** `isSearchable()` is derived from this list, so a vector index left untagged makes a vector-only table claim text search it cannot run — `$search` then reaches your adapter, which has no index to answer it with. `type` is optional only for back-compatibility: an entry that omits it is taken as text, because adapters written before the field existed only ever listed text indexes.

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
