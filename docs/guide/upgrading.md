---
outline: deep
---

# Upgrading

Changes that need action or attention when you upgrade. Each entry links to the page that documents the current behavior.

## 0.1.147 {#v0-1-147}

**Requires `moost` / `@moostjs/event-http` 0.6.43 and `@wooksjs/event-http` / `@wooksjs/http-body` 0.7.26** (`withControllerContext`, `MoostHttp.invoke`, `seedBody`).

### New features

- **Candidate-aware `actionRowScope(action, ctx)`** — the hook receives the candidate rows; see [Scopes that depend on the candidate rows](/http/actions#action-row-scope-candidates).
- **Query targets** — run a `'rows'` action on every row matching a query: [Query Targets](/http/query-targets), [`actionOnQuery`](/http/client#query-targets).
- **Actions on a view** — `@DbActionsFrom` lists a table controller's row actions on a view controller: [Actions on a View](/http/view-actions).
- **Relational filters: `$some` / `$none`.** Select rows by their related rows — `{ ticket: { $some: { status: "open" } } }`, `{ issues: { $none: {} } }` — in reads, `aggregate()`, `$with` sub-filters and mutation filters, on every bundled adapter. See [Queries § Relational filters](/api/queries#relational-filters). Over HTTP the form is `ticket=$some(status=open)` ([URL syntax](/http/query-syntax#relational-predicates)); a client may use it only on relations marked with the new [`@db.rel.filterable`](/relations/navigation#db-rel-filterable). Permission layers get [`transformRelationFilter`](/http/customization#transformrelationfilter) and `ctx.filter` in [`prepareRequest`](/http/customization#preparerequest); `/meta.relations[]` gains `filterable: true`.
- **Computed view columns and first-row joins** — `@db.compute` columns and joins that pick one related row per entry: [Computed Columns](/views/computed-columns), [First-row joins](/views/#first-row-joins). Existing views keep their schema hash, so nothing is recreated on upgrade.
- **Hourly calendar buckets** — `unit: "hour"`, labelled `YYYY-MM-DDTHH:00` in the bucket's time zone: [Hour buckets](/api/calendar-buckets#hour-buckets).

### Behavior changes {#v0-1-147-behavior}

- **`'rows'` actions validate `ids` in their gate interceptor.** Every `'rows'` action now reads and validates the body's `ids` in the action's interceptor, even without a row overlay or `disabled` — the same 400, but earlier: ahead of interceptors of a lower priority and before the handler's arguments resolve.
- **A `query` key in a `'rows'` action body is a 400** `TARGET_INVALID` unless the action declares `queryTarget` (it used to be ignored).
- **`actionRowScope` runs after the body is read** on the action route (it needs the candidate ids); `prepareRequest` and the row overlay still run before it.
- **`@DbActionsFrom` views always return the `idMap` columns** on reads, even when `$select` omits them (the client needs them to address the source) — unless the view's `transformProjection` drops them, which drops the delegation.
- **A hidden default text index is refused** (under an overridden [`hasField`](/http/customization#hasfield)): `$search` without `$index` answers `400 No search index available` when the default text index reads a field the request can't see — it used to fall back to the substring search over visible fields — and `/meta` now prunes `searchIndexes` and turns `searchable` / `vectorSearchable` / `geoSearchable` off by the same rule. Tables without native search keep the fallback. A permission layer that pruned `/meta` itself through `indexFieldPaths()` can keep doing so (same result) or drop it.
- **The "no primary key" warning** for an overridden `actionRowScope` is logged only when the controller has row actions of its own.
- **`@db.rel.filter` is applied.** It was validated and documented but ignored at run time, so `$with` loaded every related row. It now filters `$with` on every adapter and counts in predicates — a relation carrying it returns fewer rows. Two forms that used to compile cleanly are now **compile errors** (also shown in the editor): a comparison between two fields (`Post.a = Post.b`), on any relation kind; and, on a `@db.rel.via` relation, a single top-level condition that reads both the junction and the related type (an `or` across them, or a parenthesized group mixing them — split it into top-level `and` conditions). Recompile (`asc`) to see them; metadata compiled with an older plugin that still carries such a filter fails every `$with` and predicate on that relation with `INVALID_QUERY`. See [`@db.rel.filter`](/relations/navigation#db-rel-filter).
- **Application-level cascades delete the rows they cascaded for** (MongoDB, memory, adapters without native foreign keys). `deleteMany` / `deleteOne` now read the matching rows once, run cascade / set-null for them, and delete exactly those rows by primary key — the filter is not evaluated a second time. A filter that depends on the children (`{ issues: { $some: … } }`, or a `deleteOne` row scope using one) deletes the parent instead of leaving it behind with its children gone, and a row inserted between the cascade and the delete is no longer deleted without its cascade. See [Referential Actions](/relations/referential-actions).
- **Foreign keys over `@db.column`-renamed columns.** FK metadata now carries the physical column names, and DDL, foreign-key sync, the FK diff and the schema snapshot use them. A table whose `@db.rel.FK` field — or the field it references — is renamed with `@db.column` gets a new schema hash and re-syncs once after the upgrade, on every adapter including MongoDB and memory. On SQLite, PostgreSQL and MySQL such tables could not be created before (`unknown column in foreign key definition`); now they can. Tables without renamed FK columns keep their hash.
- **MongoDB: queries with `$some` / `$none` run without an operation-wide collation.** A request collation (from `'nocase'` fields) used to govern the whole pipeline — the related tables' join keys and fields included. Now each table's `'nocase'` fields are compared case-insensitively per field (`$eq` / `$ne` / `$in` / `$nin` on strings), join keys and binary fields compare byte-wise, and in such queries a string range on a `'nocase'` field or a string comparison on a `'unicode'` field is rejected with `REL_FILTER_NOT_SUPPORTED`; `$sort` there is byte-wise. Predicate-free reads keep their collation. See [MongoDB § Collation](/adapters/mongodb#relational-predicate-collation).
- **MongoDB `$with` follows the other adapters** — see [Native Relation Loading](/adapters/mongodb#native-relation-loading): renamed (`@db.column`) foreign keys and related fields load, sub-query filters are validated (an unknown field is an error, not an empty relation), a `null` foreign key loads nothing, and on `via` relations `$sort` / `$skip` / `$limit` / `$select` apply per parent row instead of per junction row. A `@db.rel.to` relation now resolves its table through the `DbSpace` like the generic loader: on a table built without one (`new AtscriptDbTable(type, adapter)`), `$with` of a `to` relation loads nothing instead of falling back to the foreign key's target name.
- **The 400 for a dotted navigation path** (`ticket.status=open`) now also suggests `ticket=$some(status=…)`.

### Fixes

- **moost-db: `$count` with a write-only field on a related table.** The write-only `$select` seal also listed related tables' `@db.writeOnly` paths, so `$count` failed with `Cannot select "ticket.code" — navigation path`.
- **PostgreSQL / MySQL: foreign keys into another schema.** `REFERENCES` named the target table without its `@db.schema`, so a foreign key into a table of another schema (PostgreSQL) or database (MySQL) could not be created. It is qualified now (`TDbForeignKey.targetSchema`).
- **PostgreSQL: tables without `@db.schema` follow the connection's current schema.** Introspection (existing columns, constraints, indexes, foreign keys) assumed `public`; with a `search_path` pointing elsewhere every such table looked missing to schema sync. It now uses `current_schema()`.
- **PostgreSQL: a `@db.column`-renamed primary key.** `updateOne` / `deleteOne` and the `RETURNING` clause of `insertOne` / `insertMany` used the field name instead of the column name and failed.

### API

- `TDbRequestEndpoint` gains `"delegatedAction"` (`prepareRequest` of a view's `POST /delegated-actions/:name`). An exhaustive `switch` over it with a `never` check needs the new case.
- `actionRowScope(action, ctx?)` — `ctx` is optional in the signature, so `super.actionRowScope(name)` keeps compiling; moost-db always passes it.
- `TDbActionInfo` gains `owner`, `idMap`, `queryTarget` (`{ maxRows, url? }`); `TDbActionTargetSummary` (`@atscript/db`) is new, with optional `aborted`, `messages`, `message`.
- New protected hook `queryTargetScope(action)` — runs as a read; see [Which rows](/http/query-targets#which-rows).
- `POST {prefix}/delegated-actions/:name` exists only on controllers declaring `@DbActionsFrom`.
- moost-db recognizes its controller classes by a registered-symbol brand, so a controller class from a second loaded copy of `@atscript/moost-db` (an SSR bundle next to the installed package) is recognized too.

For custom adapters and filter tooling:

- `BaseDbAdapter.viewCapabilities()` — default empty, so schema sync refuses a view with computed columns or a first-row join on a custom adapter until it returns them. See [Creating Adapters § viewCapabilities](/adapters/creating-adapters#view-capabilities).
- `ALL_BUCKET_UNITS` now includes `hour`: a custom adapter returning it from `calendarBucketUnits()` must render hour labels, or return a set without `hour`. See [Creating Adapters § Calendar buckets](/adapters/creating-adapters#calendar-buckets).
- `BaseDbAdapter.supportsRelationFilters(mode)` — default `false`, so a custom adapter rejects predicates with `REL_FILTER_NOT_SUPPORTED` until it renders them. See [Creating Adapters § Relational Predicates](/adapters/creating-adapters#relational-predicates).
- `walkFilter` dispatches a predicate to the visitor's new `relation(field, op, operand)` callback and throws when the visitor has none. Visitors you wrote only meet one once a filter contains a predicate — add `relation` to those that can.
- `@atscript/db-sql-tools`: `TFilterVisitorOptions.qualifier` — required on statements that alias their FROM.
- `@atscript/db-mongo`: `buildMongoFilter` throws on a predicate; `mongoFilterStages`, `buildMongoQuery` and `planStages` build the pipeline form.
- New exports in `@atscript/db`: `ResolvedRelationFilter`, `isResolvedRelationFilter` (a `Symbol.for` brand, safe across two loaded copies), `containsRelationPredicate`, `forEachResolvedRelation`, `relationStaticFilter`, `andFilters`, `REL_FILTER_MAX_DEPTH` (4) / `REL_FILTER_MAX_NODES` (16) — core limits, server-added predicates included — and `REL_FILTER_CLIENT_MAX_DEPTH` (3) / `REL_FILTER_CLIENT_MAX_NODES` (8), the HTTP client budget; from `@uniqu/core`: `RELATION_OPS`, `isRelationOp`, `isRelationPredicate`, `hasRelationOp`, `RelationOp`, `RelationPredicate`. `TRelationInfo.filterable`, `TDbRequestContext.filter` (`@atscript/moost-db`, a deep-frozen copy of the client filter).
- `BaseDbAdapter.sharesStoreWith(other)` — whether a related table can be correlated in one statement / pipeline: by default the same adapter class and the same `_transactionOwner()`; the MongoDB adapter also compares the database name. Two connections of one adapter class are different stores (`REL_FILTER_NOT_SUPPORTED`).
- `TDbForeignKey.physicalFields` / `physicalTargetFields` — the physical columns of a foreign key (`fields` / `targetFields` stay logical). Custom adapters that render `FOREIGN KEY` clauses should use them, falling back to `fields` / `targetFields` when absent.
- moost-db: the relational-predicate gate judges the client's `$with` tree as recorded before `validateControls`. An override that conjoins row scopes into `$with` entries must wrap the client's filter object, not copy or drop it — see [`validateControls`](/http/customization#validatecontrols).
- `@atscript/db-mongo`: predicate temp fields are named `__atscript_rf_<n>` (`REL_FILTER_TEMP_PREFIX`); `buildMongoQuery` / `mongoFilterStages` / `buildMongoFilter` accept `{ collation }`, `buildAggregatePipeline` / `buildCountPipeline` an optional `filterOptions`, and `MongoAdapter.fieldCollation(field)` reports a field's collation.

## 0.1.142 {#v0-1-142}

### Fixes

- **`@atscript/db-client`: derived columns are server-managed in preflight.** The `/meta` type stripped the `db.column.derived` annotation, so the client validator built from it treated a [derived column](/api/storage#derived-columns) as an ordinary field: an `insert` / `replace` that left out a required derived field was rejected with a `ClientValidationError` (the server accepts it and computes the value), and `$inc` / `$dec` / `$mul` on one reached the server before failing there. `/meta.type` now keeps `db.column.derived`, and preflight follows the server's rules — see [Client-Side Validation](/http/client#validation). `/meta.fields[path].derived` is unchanged. A controller that overrides `getSerializeOptions()` must keep `db.column.derived` itself to get the fix.

## 0.1.141 {#v0-1-141}

**Requires `@atscript/typescript` 0.1.95.** A nav field typed with a table declared in the _same_ `.as` file resolves its target through the reference the runtime records for it; 0.1.94 records one only for chain refs and imported types, so with it such a relation resolves to a table named after the type id (and loads nothing) instead of the physical table. Tables referencing each other across files are unaffected. Recompile (`asc`) after upgrading.

### New features

- **Views over views.** `@db.view.for` and `@db.view.joins` accept a `@db.view` (managed or external) as well as a `@db.table` — see [Views over views](/views/#views-over-views). The compile error for a non-source type changed from `Type 'X' must have @db.table annotation.` to `Type 'X' must be a @db.table or a @db.view.` Sync ordering, cascade recreation and the new refusals are under [Behavior changes](#v0-1-141-behavior).
- **Join aliases and self-joins** through the new `@db.alias` annotation — see [Join aliases](/views/#join-aliases-and-self-joins). The two errors that rejected a second join of one table (`… no join aliases / self-joins yet`) now suggest an alias instead; the rule itself is unchanged.
- **Derived columns: `@db.column.derived`.** A top-level table field typed as a chain reference into a `@db.json` field of the same table (`customerId: Order.payload.customer.id`) becomes a real column: a `GENERATED ALWAYS AS (…)` column on SQLite / MySQL (`VIRTUAL`) and PostgreSQL (`STORED`), and a query-time mapping to the source path on MongoDB and the memory adapter. It is filterable, sortable, groupable and indexable; a value supplied for it on a write is dropped, and `$inc` / `$dec` / `$mul` on it is a validation error. `/meta.fields[path].derived` is `true` for such a field, and safe mode gains a skip kind (`entry.skipped` may include `'derived'` — a derived-column rebuild left pending). Nothing changes for existing tables: their snapshots and hashes are byte-identical, no column is touched. See [Derived Columns](/api/storage#derived-columns) and [What gets synced → Derived Columns](/sync/what-gets-synced#derived-columns).
- **`disabled` predicates can say why.** A predicate may return a string instead of `true` for a row: the action is disabled and the string is the reason. It becomes the 409 message, `ActionDisabledError` gains `reason` / `reasons` (server body and `@atscript/db-client` accessors), and `$actions=true` reads add `$disabledReasons: { [action]: reason }` to rows that have one. Boolean predicates and existing wire fields are unchanged. If your own code evaluates the `/meta` `disabled` string, test the result for truthiness, not `=== true`. See [Disabled reasons](/http/actions#disabled-reasons).
- **Editor support.** With `@atscript/core` 0.1.94 and the Atscript VSCode extension, the db plugin scopes its own query, field-name and ref arguments: completion, hover, go-to-definition, find-references and rename work inside them, with the scope the diagnostics check (a chained `@db.view.joins` condition used to offer only the target and the entry). See [Annotations → Editor support](/adapters/annotations#editor-support).
- **`isDbEntityType(value)`** — the runtime test `DbSpace.get` applies, for filtering a module namespace before a sync — see [Syncing a module namespace](/sync/programmatic#syncing-a-module-namespace).

### Behavior changes {#v0-1-141-behavior}

- **Entity annotations stay on the interface that declares them.** `@db.table` (and `@db.table.*`), `@db.view` / `@db.view.*`, `@db.schema`, `@db.space`, `@db.http.path`, `@db.sync.method`, `@db.depth.limit` and the interface-level adapter annotations (`@db.mongo.collection` / `.capped` / `.search.*`, `@db.mysql.engine`, `@db.pg.schema`) no longer travel across a reference. A nav field (`customer?: Customer`, `orders: Order[]`), a plain `export type Admin = User` and a `@db.alias` type used to carry the referenced table's `db.table` (and the rest) in their compiled metadata, which made each of them a second runtime entity of the same table: `db.get(Admin)` opened another `AtscriptDbTable` over `users`, the `asc db sync` discovery counted it, and a `@db.alias` was collected as a model. Only the declaring interface carries them now — `db.get(Admin)` would open a table named `Admin` (the type-id fallback); pass `User`. A `@db.alias` type listed in a `syncSchema` inventory is skipped. Recompile (`asc`) to pick the change up; stored data and schemas are untouched. See [Annotations never travel across field refs](/adapters/annotations#annotations-never-travel-across-field-refs).
- **`@db.view.having` is validated.** Its field references must name the view's own fields, unqualified. A qualified reference (`Order.amount`) or an unknown field, which used to compile and fail at sync or query time, is now a compile error.
- **Schema sync orders views by dependency.** Views that read views are created after the views they read (inventory order otherwise) and recreated when an upstream view is recreated (`cascadeFrom`, printed as `· upstream view "x" recreated`); removed views are dropped dependents-first, **before** the managed views whose definition changed (they used to be dropped after). Two new pre-flight refusals: a removed view a managed view still reads, and a view source that exists nowhere. Plan entries of views list the views they read — managed or external — in `dependsOn` (tables only before), and every entry carries `cascadeFrom` (empty unless cascaded). See [What gets synced → Views that read views](/sync/what-gets-synced#views-that-read-views).
- **Existing views are untouched.** A view without aliased joins or view sources hashes byte-identically and renders the same SQL / MongoDB pipeline — no view is recreated by the upgrade.
- **A `@db.column`-renamed version field works with optimistic concurrency, and `versionColumn` is its field name.** For `@db.column 'row_version' @db.column.version version: int`, `table.versionColumn` and `/meta`'s `versionColumn` returned the storage column (`row_version`), and every consumer keyed on it: a PATCH / PUT `version` was not lifted to `$cas`, so stale writes succeeded, and it reached the update next to the auto-bump (PostgreSQL and MongoDB answered 500, MySQL stored a version derived from the client's value); `$cas: { version }` was a 400, `withOptimisticRetry` could not run, and a `version` in an SDK patch passed the direct-write check. Both now report the field name (`version`); only the stored column is `row_version`. Tables whose version field has no `@db.column` see no change. If your code read `versionColumn` to address the physical column (raw SQL, a custom adapter), switch to the field-to-column mapping (`columnMap`) or, in an adapter, `versionColumnPhysical`. See [Row Versioning](/api/versioning#the-db-column-version-annotation).

### Fixes

- **MongoDB: a unique-index violation on a patch or update is a 409.** `updateOne` / `bulkUpdate` (the native patch path), `updateMany` and `replaceMany` let the driver's `E11000` error escape — a 500 over HTTP — while inserts and replaces already threw `DbError("CONFLICT")` (409), as every other adapter does on all write paths. Every MongoDB write path maps it now.
- **Relation and foreign-key target names resolve a `@db.view` by its view name** (`tableNameOf`). Relations still target `@db.table` interfaces only — the compiler rejects `@db.rel.to` / `@db.rel.from` to a view. _(Corrected in 0.1.147: this entry used to say a relation could target a view.)_
- **Document adapters: navigation properties are not columns.** On MongoDB (and the memory adapter) the subfields of a `@db.rel.to` / `@db.rel.from` / `@db.rel.via` field (`owner.name`, `orders.id`) were listed in a new table's plan (`columnsToAdd`), although nothing is stored under a nav field — relational adapters never listed them. Schema sync now never adds, backfills or unsets anything under a nav path. The table snapshot still lists them, as before, so no stored hash changes and the upgrade triggers no re-sync.
- **Schema sync: a finished run no longer leaves its lock behind.** The lock was released while a heartbeat refresh could still be in flight. On PostgreSQL the release then deleted nothing (see the next fix), so the next `run()` — on any pod — waited for the lock to expire and returned `synced-by-peer` without syncing; on every adapter, a refresh landing after the release could overwrite the next holder's lock. The release now waits for the last refresh, and every lock write is conditional: a pod refreshes or releases only its own lock and clears an expired lock only while it is still expired (two pods clearing the same expired lock could both run DDL). Other lock fixes:
  - A `force: true` run that had to wait for another pod's lock takes the lock and runs; it no longer returns `synced-by-peer` because the stored hash matched. Non-forced runs keep that answer.
  - Only a duplicate-key `CONFLICT` on the lock insert counts as "another pod holds the lock". Other insert errors (a lost connection, say) reject `run()` instead of being read as contention.
  - A waiter that loses a freed lock to another waiter waits again within `waitTimeoutMs`, instead of throwing `Failed to acquire schema sync lock after waiting`.
  - A failed lock release is logged with `logger.warn` instead of being ignored. The run's result is unchanged, and the lock row expires after `lockTtlMs`.
- **PostgreSQL: `deleteOne` no longer misses a row that is being updated at the same time.** It picked the row by `ctid`. When a concurrent `UPDATE` of that row committed first, the row had a new `ctid`, and the delete silently removed nothing (`deletedCount: 0`). It now picks the row by primary key, as `updateOne` does since 0.1.128, and re-applies the filter, so a row updated out of the filter meanwhile is left alone. Tables without a primary key still use `ctid`.
- **PostgreSQL: a column added by sync gets its `@db.pg.collate`.** `ADD COLUMN` applied the native collation only when the field also had `@db.column.collate`; `CREATE TABLE` always applied it. Both now render the same `COLLATE` clause.

### API

For custom adapters and sync tooling:

- The schema-sync lock now treats only `DbError("CONFLICT")` from `insertOne` as a lost race for the lock row, and it writes the row through `updateMany` / `deleteMany` with `$eq` / `$lt` filters. A custom adapter must throw `DbError("CONFLICT")` on a duplicate primary key, as the bundled adapters do; a raw driver error now rejects `run()` when two pods start together.
- `TViewJoin.scope` — the name a join is addressed by: the physical `targetTable`, or the alias name of an aliased join (then `TViewJoinSnapshot.table` carries the physical table). `AtscriptDbView.resolveRefSource(ref).table` and `TViewColumnMapping.sourceTable` return that scope name — a custom adapter that renders joins must alias the physical table under it when they differ (`JOIN "employees" AS "Manager"`), as `@atscript/db-sql-tools` does. See [Creating Adapters → Views](/adapters/creating-adapters#ensureview-view).
- `tableNameOf(type)` names a `@db.view` type by its view name (its type id before).
- `versionColumnPhysical` on a table — the stored column of the `@db.column.version` field. `versionColumn` is now the field name (see [Behavior changes](#v0-1-141-behavior)); a custom adapter must bump, compare and default the version with `versionColumnPhysical`, since it works on rows already mapped to column names. See [Creating Adapters → Versioned tables](/adapters/creating-adapters#versioned-tables).
- New exports: `aliasTargetOf`, `isDbEntityType`, `getPath` / `deletePath` (the core's dot-path helpers), `TDbActionDisabledVerdict` (`@atscript/moost-db` — a `disabled` verdict, `boolean | string`); `DbSpace.get` / `getTable` / `getView` throw for a `@db.alias` type.
- Nav subfields on document adapters are `ignored` descriptors: `fieldDescriptors` still declares them, `columnDescriptors` / `storedDescriptors` leave them out, and so does `snapshotToExistingColumns(snapshot, readable)`.
- Derived columns: `TDbFieldMeta.derived` / `TDerivedColumn` (`sourcePath`, `sourceColumn`, `jsonPath`, `type`), `TExistingColumn.generated` (adapters report generated columns), `TColumnDiff.derivedChanged` / `TDerivedChangeReason`, `computeColumnDiff(desired, existing, typeMapper, { snapshot })`, `SyncEntry.derivedChanges` / `TSyncDerivedChange`, `TReadControls` (the controls a field mapper's `reconstructFromRead` / `reconstructRows` receive), and `derivedColumnExpr` in `@atscript/db-sql-tools`. A readable exposes `columnDescriptors` (what schema sync diffs — on document adapters without the derived fields) and `storedDescriptors` (non-ignored, non-derived — what a recreate copies and a full replace assigns) next to `fieldDescriptors`. What a custom adapter must do is in [Creating Adapters → Derived columns](/adapters/creating-adapters#derived-columns).

## 0.1.140 {#v0-1-140}

### MySQL

- **Schema sync no longer converts data silently on a server that is not strict.** Its converting statements (`MODIFY COLUMN`, the `NOT NULL` backfill, the primary-key rebuild, the `@db.sync.method 'recreate'` copy) now run with `STRICT_ALL_TABLES` added to the session `sql_mode`. On a server that is not strict — Amazon RDS for MySQL defaults to `NO_ENGINE_SUBSTITUTION` — a string → number change used to turn `'abc'` into `0`, and lowering `@expect.maxLength` truncated stored text, while the sync reported success. Both now fail the sync as an `error` entry and leave the data as it was. Clean or migrate values that do not convert before changing a column's type. Strict servers see no change. See [MySQL → Conversions are strict](/adapters/mysql#strict-conversions).

## 0.1.139 {#v0-1-139}

### MongoDB

- **`@db.sync.method 'recreate'` never puts the documents at risk.** The new collection is built under a temporary name, filled server-side, and swapped in with one atomic rename; a failed step drops the temporary collection and leaves the original untouched. Before, the original was dropped first, and a failure left the documents only in a `<name>__tmp_<ts>` collection, with no error naming it — see [MongoDB → Capped Collections](/adapters/mongodb#capped-collections).

### PostgreSQL

- **Sync fix: foreign keys of two tables that share a constraint name are no longer mixed up.** Constraint names are unique per table, not per schema. Sync read foreign keys by name within the schema, so two tables with a same-named foreign key had their columns merged: the FK diff saw columns from the other table, and a `@db.sync.method 'recreate'` of the referenced table failed or restored a wrong constraint. Constraints are now read per table from `pg_catalog`. Names that sync generates (`<table>_<cols>_fkey`) only collided after truncation to 63 characters; hand-named constraints could collide freely.

## 0.1.138 {#v0-1-138}

### Memory

- **Sync now runs the pre-flight name checks.** The memory adapter implements [`getObjectKind`](/adapters/creating-adapters#getobjectkind-name), so a sync that declares a managed view where a table sits (or a table where a view sits) is refused, as on SQL and MongoDB. Before, the clash went unnoticed.
- **A foreign key to a table that is not in the space is refused.** A `@db.rel.FK` whose target is neither in the sync inventory nor already in the space's in-memory database fails pre-flight (`FK <table>.<cols> references "<target>" which is neither in the sync inventory nor present in the database`). Before, the check was skipped. Sync the target table in the same run, or sync it first in the same `DbSpace` — see [Memory → Schema Sync](/adapters/memory#schema-sync).

### MySQL

- **A failed `@db.sync.method 'recreate'` no longer leaves a `<table>__tmp_<ts>` table behind.** When the copy fails, the temp table is dropped and the table keeps its rows. Before, every failed attempt left one; drop any you find from earlier runs. A failure after the original table was dropped keeps the temp table, because it holds the only copy of the rows, and the error names it (`… its rows are in "<table>__tmp_<ts>"`) — see [What gets synced → Copy and Swap](/sync/what-gets-synced#recreate-copy-and-swap).

### SQLite

- **`@db.sync.method 'recreate'` runs in one transaction.** A step that fails rolls the whole recreate back: the table keeps its rows and its full-text and vector indexes, and no `<table>__tmp_<ts>` table is left behind (before, one was, and the indexes were already gone).

## 0.1.137 {#v0-1-137}

### MongoDB

- **A `@db.column` on a nested field is ignored on MongoDB.** Documents rename top-level keys only, and the nested field was always written at its logical path (`address.zip`), but filters, `$sort`, `$groupBy`, indexes and view pipelines addressed the `@db.column` name as a top-level key (`zip_code`) — they matched nothing, sorted by nothing, and views read an empty column. Every path now uses `address.zip`, so these queries return rows for the first time. Stored data needs no migration. SQL adapters are unchanged (`address__zip_code`) — see [MongoDB → Renamed Fields](/adapters/mongodb#renamed-fields).
- **The first sync after the upgrade reports such a field once** as added (`address.zip`) and its old name (`zip_code`) as removed, and recreates an index declared on it on the stored path. Outside `--safe` mode the removal unsets a top-level `zip_code` key — only an `updateMany` merge patch on 0.1.136 could have written one.
- **Sync safety fix: the default backfill no longer overwrites stored values.** Adding a field with a literal `@db.default` used to write the default into every document; it now fills only documents that don't hold the field — which also keeps the stored `address.zip` values above intact. See [What gets synced → Add](/sync/what-gets-synced#add).
- **Every managed MongoDB view is recreated once** on the first sync after the upgrade (`plan()` / `--dry-run` shows each as an alter), so existing views pick up the fixes below. Views are metadata-only on MongoDB — no data is copied. External views are untouched.
- **Fields under a renamed top-level object resolve to their stored path everywhere.** For `profile.bio` under `@db.column 'prof'`: an index declared on it now covers `prof.bio` — the first sync recreates it (before, it indexed the non-existent `profile.bio`); `updateMany` merge patches write `prof.bio`; and `$inc` / `$mul` on a renamed field update its `@db.column` key (before, both wrote a stray key under the logical name). The first sync also reports `prof.bio` added and `profile.bio` removed once — the removal unsets a path that holds no data, and the backfill never overwrites `prof.bio`.
- **View filters with a field-to-field comparison may return fewer rows.** `` `Item.qty > Item.cap` `` in `@db.view.filter` / `@db.view.having` used to match documents where either field is null or missing (a missing value compares below every number); it now excludes them, as on SQL — see [MongoDB → Views](/adapters/mongodb#views). Add an explicit `or Item.cap not exists` where you relied on the old result.

### Memory

- **Sync fix: a model removed from the schema is really dropped.** Sync reported the table as `drop` but kept its rows, and a model added back was reported `in-sync` and served them again. The table's rows, unique indexes and increment counter are now deleted; added back, it is reported `create` and starts empty, as on SQL. Removed views are dropped too. See [Memory → Schema Sync](/adapters/memory#schema-sync).
- **Tables are keyed by name within a `DbSpace`.** Two compiled types that name the same table now share its rows, as on a real database; before, each type had its own store. A new space still starts empty.

### PostgreSQL

- **Sync fix: `@db.sync.method 'recreate'` handles a required column's type change.** The copy step failed with `invalid input syntax for type double precision: ""` (number → string), so the table could never be recreated. Changed columns are now converted to their new type the way an in-place type change converts them. A value that does not convert fails the sync inside the transaction, and the table keeps its rows. See [PostgreSQL → Column Type Changes](/adapters/postgresql#column-type-changes).
- **Shrinking a `VARCHAR` / `CHAR` column fails instead of truncating.** Lowering `@expect.maxLength` below a stored value used to cut the value silently; the sync now fails with `value too long for type character varying(n)`. Shorten the data first.

### Custom adapters

- **New optional capability [`viewRenderRevision()`](/adapters/creating-adapters#view-render-revision)** — bump it to have sync recreate your adapter's managed views once.
- **A missing drop primitive is an error, not a silent skip.** [`dropTableByName`](/adapters/creating-adapters#droptablebyname-name) and `dropViewByName` are no longer optional: the `BaseDbAdapter` defaults throw `… is not supported by this adapter`. Before, `DbSpace` skipped the drop when the adapter lacked the method, and sync reported the table or view dropped. Sync now reports it as an `error` entry and keeps it tracked. All built-in adapters implement both.
- **New hook [`registerSpace(space)`](/adapters/creating-adapters#register-space).** `DbSpace` calls it on every adapter it builds. It does nothing by default; override it to share state across a space's adapters.

## 0.1.136 {#v0-1-136}

### Managed views are recreated once

- **Every managed view is recreated on the first sync after the upgrade.** The view definition now includes each column's physical source and its aggregate, so every stored hash changes. `plan()` / `--dry-run` shows each view as an alter on that run. Plan for the costs listed in [What gets synced → Views](/sync/what-gets-synced#views).
- **MongoDB inner joins are now inner.** Before, every `@db.view.joins` kept unmatched documents on MongoDB (left-join behavior), while SQL adapters dropped them. Add `'left'` as the third argument where you relied on the old MongoDB behavior — see [Joins](/views/#joins).
- **Invalid view predicates fail at sync.** Join conditions and filters with `in`, `not in`, `exists` or `not exists` used to render wrong SQL silently; they now render correctly. `matches` in a view predicate on SQL, and any predicate that can't be rendered, now fails the sync instead of creating a broken view — see [View Filters](/views/#view-filters).
- **A view ref to a `@db.ignore` field or a navigation relation fails at sync** (`… has no column — "x" is @db.ignore or a navigation relation`) instead of producing a broken column.
- **View sync refuses aggregate functions the adapter doesn't declare.** A `@db.agg.*` field whose function is missing from the adapter's [`aggregateFns()`](/adapters/creating-adapters#aggregate-functions) fails the sync. Every built-in adapter declares all six functions; this affects custom adapters only.
- **MongoDB `@db.view.filter` / `@db.view.having` use query semantics.** `exists` now means "holds a value" (a stored `null` counts as absent) instead of key presence, `not exists` works, and `matches` accepts `/pattern/flags` — see [MongoDB → Views](/adapters/mongodb#views).

### Query results

- **MongoDB `count(field)` no longer counts documents where the field is missing** — it now matches SQL `COUNT(field)`, which counts only values that are present and not null. See [Aggregate functions](/api/aggregation#aggregate-functions).
- **The default aggregate alias over a `@db.column`-renamed field is the logical name.** `sum(amount)` over `@db.column 'amount_cents'` used to return `sum_amount_cents`, and a `$having` or `$sort` on `sum_amount` did not match it. It now returns `sum_amount` on every adapter. Update clients that read the physical-name key.

### Types and APIs

- **Compiled `db.agg.*` metadata is `{ field?, condition? }`.** It used to be a string (the field) or `true` (bare `@db.agg.count`). The runtime reads every shape, so models compiled by older versions keep working. Update any tooling that reads the metadata directly — see [Conditional Aggregates](/views/aggregations#conditional-aggregates).
- **`TDbAggregateFn` (`@atscript/db/agg`) includes `countDistinct`.** A `Record<TDbAggregateFn, …>` lookup table in your code needs a `countDistinct` entry.
- **`AGG_FN_SQL` (`@atscript/db-sql-tools`) is keyed by `Exclude<TDbAggregateFn, "countDistinct">`.** It still maps `sum`, `count`, `avg`, `min` and `max`, but indexing it with a plain `TDbAggregateFn` no longer type-checks. `countDistinct` has no function name to map — render it as `COUNT(DISTINCT x)` yourself.
- **`resolveCalendarBuckets` is deprecated.** Use `normalizeComputedSelect`, which has the same signature — see [Calendar buckets for adapter authors](/adapters/creating-adapters#calendar-buckets).
- **Class-level actions can declare an input form.** `@DbActions` / `@DbRowActions` / `@DbRowsActions` entries take `inputForm`: a compiled `.as` type, or `{ name, url }` for a form served by another controller. Any other shape is a type error; JavaScript callers that pass one get the entry dropped with a warning. See [Input forms on class-level entries](/http/actions#class-level-input-form).
