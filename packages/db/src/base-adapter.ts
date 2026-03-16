import { AsyncLocalStorage } from "node:async_hooks";

import type {
  TAtscriptAnnotatedType,
  TMetadataMap,
  TValidatorPlugin,
} from "@atscript/typescript/utils";

import type { FilterExpr } from "@uniqu/core";

import type {
  DbQuery,
  TDbIndex,
  TSearchIndexInfo,
  TDbRelation,
  TDbForeignKey,
  TExistingColumn,
  TExistingTableOption,
  TColumnDiff,
  TTableOptionDiff,
  TSyncColumnResult,
  TDbFieldMeta,
  TTableResolver,
  TDbDefaultFn,
  TMetadataOverrides,
  TValueFormatterPair,
} from "./types";
import type {
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbDeleteResult,
} from "./types";
import type { WithRelation } from "@uniqu/core";
import type { AtscriptDbReadable } from "./table/db-readable";
import type { TableMetadata } from "./table/table-metadata";
import type { TGenericLogger } from "./logger";
import { NoopLogger } from "./logger";

// ── Constants ────────────────────────────────────────────────────────────────

const EMPTY_DEFAULT_FNS: ReadonlySet<TDbDefaultFn> = new Set();

// ── Transaction context ─────────────────────────────────────────────────────

interface TxContext {
  state: unknown;
}
const txStorage = new AsyncLocalStorage<TxContext>();

/**
 * Abstract base class for database adapters.
 *
 * Adapter instances are 1:1 with readable instances (tables or views).
 * When an {@link AtscriptDbReadable} is created with an adapter, it calls
 * {@link registerReadable} to establish a bidirectional relationship:
 *
 * ```
 * AtscriptDbReadable ──delegates ops──▶ BaseDbAdapter
 *                    ◀──reads metadata── (via this._table)
 * ```
 *
 * Adapter authors can access all computed metadata through `this._table`:
 * - `this._table.tableName` — resolved table/collection/view name
 * - `this._table.flatMap` — all fields as dot-notation paths
 * - `this._table.indexes` — computed index definitions
 * - `this._table.primaryKeys` — primary key field names
 * - `this._table.columnMap` — logical → physical column mappings
 * - `this._table.defaults` — default value configurations
 * - `this._table.ignoredFields` — fields excluded from DB
 * - `this._table.uniqueProps` — single-field unique index properties
 * - `this._table.isView` — whether this is a view (vs a table)
 */
export abstract class BaseDbAdapter {
  // ── Table/view back-reference ─────────────────────────────────────────────

  protected _table!: AtscriptDbReadable<any, any, any, any, any, any, any>;

  private _metaIdPhysical: string | null | undefined;

  /**
   * Returns the physical column name of the single @meta.id field (if any).
   * Used to return the user's logical ID instead of the DB-generated ID on insert.
   */
  protected _getMetaIdPhysical(): string | null {
    if (this._metaIdPhysical === undefined) {
      const fields = this._table.originalMetaIdFields;
      if (fields.length === 1) {
        const field = fields[0];
        this._metaIdPhysical = this._table.columnMap.get(field) ?? field;
      } else {
        this._metaIdPhysical = null;
      }
    }
    return this._metaIdPhysical;
  }

  /**
   * Resolves the correct insertedId: prefers the user-supplied PK value
   * from the data over the DB-generated fallback (e.g. rowid, _id).
   */
  protected _resolveInsertedId(data: Record<string, unknown>, dbGeneratedId: unknown): unknown {
    const metaIdPhysical = this._getMetaIdPhysical();
    return metaIdPhysical ? (data[metaIdPhysical] ?? dbGeneratedId) : dbGeneratedId;
  }

  /** Logger instance — set via {@link registerReadable} from the readable's logger. */
  protected logger: TGenericLogger = NoopLogger;

  /** When true, adapter logs DB calls via `logger.debug`. Off by default. */
  protected _verbose = false;

  /**
   * Called by {@link AtscriptDbReadable} constructor. Gives the adapter access
   * to the readable's computed metadata for internal use in query rendering,
   * index sync, etc.
   */
  registerReadable(
    readable: AtscriptDbReadable<any, any, any, any, any, any, any>,
    logger?: TGenericLogger,
  ): void {
    this._table = readable;
    if (logger) {
      this.logger = logger;
    }
  }

  /**
   * Enables or disables verbose (debug-level) logging for this adapter.
   * When disabled, no log strings are constructed — zero overhead.
   */
  setVerbose(enabled: boolean): void {
    this._verbose = enabled;
  }

  /**
   * Logs a debug message if verbose mode is enabled.
   * Adapters call this to log DB operations with zero overhead when disabled.
   */
  protected _log(...args: unknown[]): void {
    if (!this._verbose) {
      return;
    }
    this.logger.debug(...args);
  }

  // ── Transaction support ──────────────────────────────────────────────────

  /**
   * Runs `fn` inside a database transaction. Nested calls (from related tables
   * within the same async chain) reuse the existing transaction automatically.
   *
   * The generic layer handles nesting detection via `AsyncLocalStorage`.
   * Adapters override `_beginTransaction`, `_commitTransaction`, and
   * `_rollbackTransaction` to provide raw DB-specific transaction primitives.
   */
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (txStorage.getStore()) {
      return fn();
    }

    const ctx: TxContext = { state: undefined };
    ctx.state = await this._beginTransaction();
    return txStorage.run(ctx, async () => {
      try {
        const result = await fn();
        await this._commitTransaction(ctx.state);
        return result;
      } catch (error) {
        try {
          await this._rollbackTransaction(ctx.state);
        } catch {
          /* preserve original error */
        }
        throw error;
      }
    });
  }

  /**
   * Returns the opaque transaction state from the current async context.
   * Adapters use this to retrieve DB-specific state (e.g., MongoDB `ClientSession`).
   */
  protected _getTransactionState(): unknown {
    return txStorage.getStore()?.state;
  }

  /**
   * Runs `fn` inside the transaction ALS context with the given state.
   * Adapters that override `withTransaction` (e.g., to use MongoDB's
   * `session.withTransaction()` Convenient API) use this to set up the
   * shared context so that nested adapters see the same session.
   * If a context already exists (nesting), it's reused.
   */
  protected _runInTransactionContext<T>(state: unknown, fn: () => Promise<T>): Promise<T> {
    if (txStorage.getStore()) {
      return fn();
    }
    return txStorage.run({ state }, fn);
  }

  /**
   * Starts a raw transaction. Returns opaque state stored in the async context.
   * Override in adapters that support transactions.
   */
  protected async _beginTransaction(): Promise<unknown> {
    return undefined;
  }

  /** Commits the raw transaction. Override in adapters that support transactions. */
  protected async _commitTransaction(_state: unknown): Promise<void> {}

  /** Rolls back the raw transaction. Override in adapters that support transactions. */
  protected async _rollbackTransaction(_state: unknown): Promise<void> {}

  // ── Validation hooks (overridable) ────────────────────────────────────────

  /**
   * Returns additional validator plugins for this adapter.
   * These are merged with the built-in Atscript validators.
   *
   * Example: MongoDB adapter returns ObjectId validation plugin.
   */
  getValidatorPlugins(): TValidatorPlugin[] {
    return [];
  }

  // ── ID preparation (overridable) ──────────────────────────────────────────

  /**
   * Transforms an ID value for the database.
   * Override to convert string → ObjectId, parse numeric IDs, etc.
   *
   * @param id - The raw ID value.
   * @param fieldType - The annotated type of the ID field.
   * @returns The transformed ID value.
   */
  prepareId(id: unknown, _fieldType: TAtscriptAnnotatedType): unknown {
    return id;
  }

  // ── Native patch support (overridable) ────────────────────────────────────

  /**
   * Whether this adapter supports native patch operations.
   * When `true`, {@link AtscriptDbTable} delegates patch payloads to
   * {@link nativePatch} instead of using the generic decomposition.
   */
  supportsNativePatch(): boolean {
    return false;
  }

  /**
   * Whether this adapter handles nested objects natively.
   * When `true`, the generic layer skips flattening and
   * passes nested objects as-is to the adapter.
   * MongoDB returns `true`; relational adapters return `false` (default).
   */
  supportsNestedObjects(): boolean {
    return false;
  }

  /**
   * Whether the DB engine handles static `@db.default "value"` natively
   * via column-level DEFAULT clauses in CREATE TABLE.
   * When `true`, `_applyDefaults()` skips client-side value defaults,
   * letting the DB apply its own DEFAULT. SQL adapters return `true`;
   * document stores (MongoDB) return `false` and apply defaults client-side.
   */
  supportsNativeValueDefaults(): boolean {
    return false;
  }

  /**
   * Function default names handled natively by this adapter's DB engine.
   * Fields with these defaults are omitted from INSERT when no value is provided,
   * letting the DB apply its own DEFAULT expression (e.g. CURRENT_TIMESTAMP, UUID()).
   *
   * Override in adapters whose DB engine supports function defaults.
   * The generic layer checks this in `_applyDefaults()` to decide whether
   * to generate the value client-side or leave it for the DB.
   */
  nativeDefaultFns(): ReadonlySet<TDbDefaultFn> {
    return EMPTY_DEFAULT_FNS;
  }

  /**
   * Whether this adapter enforces foreign key constraints natively.
   * When `true`, the generic layer skips application-level cascade/setNull
   * on delete — the DB engine handles it (e.g. SQLite `ON DELETE CASCADE`).
   * When `false` (default), the generic layer implements cascade logic
   * by finding child records and deleting/nullifying them before the parent.
   */
  supportsNativeForeignKeys(): boolean {
    return false;
  }

  // ── Relation loading (overridable) ────────────────────────────────────────

  /**
   * Whether this adapter handles `$with` relation loading natively.
   * When `true`, the table layer delegates to {@link loadRelations}
   * instead of using the generic batch-loading strategy.
   *
   * Adapters can use this to implement SQL JOINs, MongoDB `$lookup`,
   * or other DB-native relation loading optimizations.
   *
   * Default: `false` — the table layer uses application-level batch loading.
   */
  supportsNativeRelations(): boolean {
    return false;
  }

  /**
   * Loads relations onto result rows using adapter-native operations.
   * Only called when {@link supportsNativeRelations} returns `true`.
   *
   * The adapter receives the rows to enrich, the `$with` relation specs,
   * and the table's relation/FK metadata for resolution.
   *
   * @param rows - The result rows to enrich (mutable — add relation properties in place).
   * @param withRelations - The `$with` specs from the query.
   * @param relations - This table's relation metadata (from `@db.rel.to`/`@db.rel.from`).
   * @param foreignKeys - This table's FK metadata (from `@db.rel.FK`).
   * @param tableResolver - Optional callback to resolve annotated types to table metadata (needed for FROM/VIA relations).
   */
  // oxlint-disable-next-line max-params
  async loadRelations(
    _rows: Array<Record<string, unknown>>,
    _withRelations: WithRelation[],
    _relations: ReadonlyMap<string, TDbRelation>,
    _foreignKeys: ReadonlyMap<string, TDbForeignKey>,
    _tableResolver?: TTableResolver,
  ): Promise<void> {
    throw new Error("Native relation loading not supported by this adapter");
  }

  /**
   * Applies a patch payload using native database operations.
   * Only called when {@link supportsNativePatch} returns `true`.
   *
   * @param filter - Filter identifying the record to patch.
   * @param patch - The patch payload with array operations.
   * @returns Update result.
   */
  async nativePatch(_filter: FilterExpr, _patch: unknown): Promise<TDbUpdateResult> {
    throw new Error("Native patch not supported by this adapter");
  }

  // ── Adapter-specific annotation processing (overridable) ──────────────────

  /**
   * Called before field flattening begins.
   * Use to extract table-level adapter-specific annotations.
   *
   * Example: MongoDB adapter extracts `@db.mongo.search.dynamic`.
   */
  onBeforeFlatten?(type: TAtscriptAnnotatedType): void;

  /**
   * Called for each non-nav-descendant field during the build pipeline.
   * Fields nested under navigation relations (`@db.rel.to/from/via`) are
   * never delivered to this callback — adapters do not need to filter them.
   *
   * Use to extract field-level adapter-specific annotations.
   * Example: MongoDB adapter extracts `@db.mongo.search.vector`, `@db.mongo.search.text`.
   */
  onFieldScanned?(
    field: string,
    type: TAtscriptAnnotatedType,
    metadata: TMetadataMap<AtscriptMetadata>,
  ): void;

  /**
   * Returns metadata overrides applied during the build pipeline.
   * Called after field scanning/classification, before field descriptors are built.
   *
   * Use this to adjust primary keys, inject synthetic fields, or register
   * unique constraints — instead of mutating metadata via back-references.
   *
   * @param meta - The table metadata (direct reference, not through readable getters).
   */
  getMetadataOverrides?(meta: TableMetadata): TMetadataOverrides | undefined;

  /**
   * Called after all fields are scanned.
   * Use to finalize adapter-specific computed state.
   * Access table metadata via `this._table`.
   */
  onAfterFlatten?(): void;

  /**
   * Returns an adapter-specific table name.
   * For example, MongoDB reads from `@db.mongo.collection`.
   * Return `undefined` to fall back to `@db.table` or the interface name.
   */
  getAdapterTableName?(type: TAtscriptAnnotatedType): string | undefined;

  /**
   * Returns the metadata tag used to mark top-level arrays during flattening.
   * Default: `'db.__topLevelArray'`
   *
   * Override to use adapter-specific tags (e.g., `'db.mongo.__topLevelArray'`).
   */
  getTopLevelArrayTag?(): string;

  // ── Table name resolution ──────────────────────────────────────────────────

  /**
   * Resolves the full table name, optionally including the schema prefix.
   * Override for databases that don't support schemas (e.g., SQLite).
   *
   * @param includeSchema - Whether to prepend `schema.` prefix (default: true).
   */
  resolveTableName(includeSchema = true): string {
    const schema = this._table.schema;
    const name = this._table.tableName;
    return includeSchema && schema ? `${schema}.${name}` : name;
  }

  // ── Index sync helper ──────────────────────────────────────────────────────

  /**
   * Template method for index synchronization.
   * Implements the diff algorithm (list → compare → create/drop).
   * Adapters provide the three DB-specific primitives.
   *
   * @example
   * ```typescript
   * async syncIndexes() {
   *   await this.syncIndexesWithDiff({
   *     listExisting: async () => this.driver.all('PRAGMA index_list(...)'),
   *     createIndex: async (index) => this.driver.exec('CREATE INDEX ...'),
   *     dropIndex: async (name) => this.driver.exec('DROP INDEX ...'),
   *     shouldSkipType: (type) => type === 'fulltext',
   *   })
   * }
   * ```
   */
  protected async syncIndexesWithDiff(opts: {
    listExisting(): Promise<Array<{ name: string }>>;
    createIndex(index: TDbIndex): Promise<void>;
    dropIndex(name: string): Promise<void>;
    prefix?: string;
    shouldSkipType?(type: TDbIndex["type"]): boolean;
  }): Promise<void> {
    const prefix = opts.prefix ?? "atscript__";

    // List existing indexes, filter to managed ones
    const existing = await opts.listExisting();
    const existingNames = new Set(
      existing.filter((i) => i.name.startsWith(prefix)).map((i) => i.name),
    );

    const desiredNames = new Set<string>();

    // Create missing indexes
    for (const index of this._table.indexes.values()) {
      if (opts.shouldSkipType?.(index.type)) {
        continue;
      }

      desiredNames.add(index.key);

      if (!existingNames.has(index.key)) {
        await opts.createIndex(index);
      }
    }

    // Drop stale indexes
    for (const name of existingNames) {
      if (!desiredNames.has(name)) {
        await opts.dropIndex(name);
      }
    }
  }

  // ── Search index metadata ─────────────────────────────────────────────────

  /**
   * Returns available search indexes for this adapter.
   * UI uses this to show index picker. Override in adapters that support search.
   */
  getSearchIndexes(): TSearchIndexInfo[] {
    return [];
  }

  /**
   * Whether this adapter supports text search.
   * Default: `true` when {@link getSearchIndexes} returns any entries.
   */
  isSearchable(): boolean {
    return this.getSearchIndexes().length > 0;
  }

  /**
   * Whether this adapter supports vector similarity search.
   * Override in adapters that support vector search.
   */
  isVectorSearchable(): boolean {
    return false;
  }

  // ── Search ──────────────────────────────────────────────────────────────

  /**
   * Full-text search. Override in adapters that support search.
   *
   * @param text - Search text.
   * @param query - Filter, sort, limit, etc.
   * @param indexName - Optional search index to target.
   */
  async search(
    _text: string,
    _query: DbQuery,
    _indexName?: string,
  ): Promise<Array<Record<string, unknown>>> {
    throw new Error("Search not supported by this adapter");
  }

  /**
   * Full-text search with count (for paginated search results).
   *
   * @param text - Search text.
   * @param query - Filter, sort, limit, etc.
   * @param indexName - Optional search index to target.
   */
  async searchWithCount(
    _text: string,
    _query: DbQuery,
    _indexName?: string,
  ): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
    throw new Error("Search not supported by this adapter");
  }

  // ── Vector Search ─────────────────────────────────────────────────────

  /**
   * Vector similarity search. Override in adapters that support vector search.
   *
   * @param vector - Pre-computed embedding vector.
   * @param query - Filter, sort, limit, etc.
   * @param indexName - Optional vector index to target (for multi-vector documents).
   */
  async vectorSearch(
    _vector: number[],
    _query: DbQuery,
    _indexName?: string,
  ): Promise<Array<Record<string, unknown>>> {
    throw new Error("Vector search not supported by this adapter");
  }

  /**
   * Vector similarity search with count (for paginated results).
   *
   * @param vector - Pre-computed embedding vector.
   * @param query - Filter, sort, limit, etc.
   * @param indexName - Optional vector index to target (for multi-vector documents).
   */
  async vectorSearchWithCount(
    _vector: number[],
    _query: DbQuery,
    _indexName?: string,
  ): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
    throw new Error("Vector search not supported by this adapter");
  }

  // ── Optimized pagination ──────────────────────────────────────────────

  /**
   * Fetches records and total count in one call.
   * Default: two parallel calls. Adapters may override for single-query optimization.
   */
  async findManyWithCount(
    query: DbQuery,
  ): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
    const [data, count] = await Promise.all([this.findMany(query), this.count(query)]);
    return { data, count };
  }

  /**
   * Executes an aggregate query (GROUP BY + aggregate functions).
   * Default throws — override in adapters that support aggregation.
   */
  async aggregate(_query: DbQuery): Promise<Array<Record<string, unknown>>> {
    throw new Error("Aggregation not supported by this adapter");
  }

  // ── Abstract CRUD — adapters must implement ───────────────────────────────
  // The adapter reads this._table.tableName and any other metadata it needs
  // internally. No table name parameter needed.

  abstract insertOne(data: Record<string, unknown>): Promise<TDbInsertResult>;
  abstract insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult>;
  abstract replaceOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult>;
  abstract updateOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult>;
  abstract deleteOne(filter: FilterExpr): Promise<TDbDeleteResult>;
  abstract findOne(query: DbQuery): Promise<Record<string, unknown> | null>;
  abstract findMany(query: DbQuery): Promise<Array<Record<string, unknown>>>;
  abstract count(query: DbQuery): Promise<number>;

  // ── Batch operations ──────────────────────────────────────────────────────

  abstract updateMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult>;
  abstract replaceMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult>;
  abstract deleteMany(filter: FilterExpr): Promise<TDbDeleteResult>;

  // ── Schema ────────────────────────────────────────────────────────────────

  /**
   * Synchronizes indexes between the Atscript definitions and the database.
   * Uses `this._table.indexes` for the full index definitions.
   */
  abstract syncIndexes(): Promise<void>;

  /**
   * Ensures the table exists in the database, creating it if needed.
   * Uses `this._table.tableName`, `this._table.schema`, etc.
   */
  abstract ensureTable(): Promise<void>;

  /**
   * Synchronizes foreign key constraints between Atscript definitions and the database.
   * Uses `this._table.foreignKeys` for the full FK definitions.
   * Optional — only relational adapters need to implement this.
   */
  /**
   * Post-sync hook called after all table operations (columns, indexes, FKs)
   * are complete. Adapters can use this for finalization work such as
   * resetting auto-increment sequences to match existing data.
   * Optional — most adapters don't need this.
   */
  afterSyncTable?(): Promise<void>;

  async syncForeignKeys?(): Promise<void>;

  /**
   * Drops FK constraints identified by their canonical local column key.
   * Called by the sync executor before column operations to remove stale FKs
   * that would otherwise block ALTER COLUMN.
   *
   * @param fkFieldKeys - Canonical FK keys (sorted local field names, comma-joined).
   */
  dropForeignKeys?(fkFieldKeys: string[]): Promise<void>;

  /**
   * Returns the desired table options from Atscript annotations.
   * Called after onBeforeFlatten/onAfterFlatten, so adapter-specific state
   * (e.g., engine, charset, capped options) is populated.
   *
   * Values are stringified for consistent comparison.
   * Returns undefined if the adapter has no table-level options.
   */
  getDesiredTableOptions?(): TExistingTableOption[];

  /**
   * Returns the current table options from the live database.
   * Primary source for option diffing (DB-first strategy).
   *
   * Returns undefined if the adapter cannot introspect table options.
   * In that case, schema sync falls back to stored snapshot.
   */
  getExistingTableOptions?(): Promise<TExistingTableOption[]>;

  /**
   * Applies non-destructive table option changes (e.g., MySQL ALTER TABLE ENGINE=X).
   * Called for each non-destructive change in the diff.
   * Destructive changes go through dropTable+ensureTable or recreateTable.
   */
  applyTableOptions?(changes: TTableOptionDiff["changed"]): Promise<void>;

  /**
   * Returns the set of option keys where a value change requires table recreation.
   * Default: empty (all changes are non-destructive).
   */
  destructiveOptionKeys?(): ReadonlySet<string>;

  /**
   * Checks whether the table/collection already exists in the database.
   * Used by schema sync to determine create vs in-sync status for
   * adapters that don't implement column introspection (e.g. MongoDB).
   */
  tableExists?(): Promise<boolean>;

  /**
   * Returns existing columns from the database via introspection.
   * Used by schema sync for column diffing.
   * Optional — schema-less adapters (MongoDB) skip this.
   */
  getExistingColumns?(): Promise<TExistingColumn[]>;

  /**
   * When true, the adapter can handle column type changes in-place
   * (e.g. MySQL's ALTER TABLE MODIFY COLUMN) without requiring table recreation.
   * The generic sync layer will delegate type changes to {@link syncColumns}
   * instead of requiring `@db.sync.method "recreate"` or `"drop"`.
   */
  supportsColumnModify?: boolean;

  /**
   * Applies column diff (ALTER TABLE ADD COLUMN, etc.).
   * The generic layer computes the diff; adapters execute DB-specific DDL.
   * Optional — only relational adapters implement this.
   */
  syncColumns?(diff: TColumnDiff): Promise<TSyncColumnResult>;

  /**
   * Recreates the table losslessly: create temp → copy data → drop old → rename.
   * Used by `@db.sync.method "recreate"` when structural changes can't be ALTER'd.
   * Optional — only relational adapters implement this.
   */
  recreateTable?(): Promise<void>;

  /**
   * Drops the table entirely.
   * Used by `@db.sync.method "drop"` for tables with ephemeral data.
   * Optional — only relational adapters implement this.
   */
  dropTable?(): Promise<void>;

  /**
   * Drops one or more columns from the table.
   * Used by schema sync to remove stale columns no longer in the schema.
   * Optional — only relational adapters implement this.
   */
  dropColumns?(columns: string[]): Promise<void>;

  /**
   * Drops a table by name (without needing a registered readable).
   * Used by schema sync to remove tables no longer in the schema.
   * Optional — only relational adapters implement this.
   */
  dropTableByName?(tableName: string): Promise<void>;

  /**
   * Drops a view by name (without needing a registered readable).
   * Used by schema sync to remove views no longer in the schema.
   * Optional — only relational adapters implement this.
   */
  dropViewByName?(viewName: string): Promise<void>;

  /**
   * Renames a table/collection from `oldName` to the adapter's current table name.
   * Used by schema sync when `@db.table.renamed` is present.
   * Optional — only relational adapters implement this.
   */
  renameTable?(oldName: string): Promise<void>;

  /**
   * Introspects columns for an arbitrary table name (not the adapter's own table).
   * Used by schema sync `plan()` to inspect a table under its old name before rename.
   * Optional — only relational adapters implement this.
   */
  getExistingColumnsForTable?(tableName: string): Promise<TExistingColumn[]>;

  /**
   * Maps a field's metadata to the adapter's native column type string.
   * Receives the full field descriptor (design type, annotations, PK status, etc.)
   * so adapters can produce context-aware types (e.g., `VARCHAR(255)` from maxLength).
   * Used by schema sync to detect column type changes.
   * Optional — adapters that don't implement this skip type change detection.
   */
  typeMapper?(field: TDbFieldMeta): string;

  /**
   * Returns a value formatter for a field, or undefined if no formatting is needed.
   * Called once per field during build. The returned formatter(s) are cached and
   * applied during write preparation, filter translation, and read reconstruction.
   *
   * Can return:
   * - A bare function: used as `toStorage` only (write + filter paths)
   * - A `TValueFormatterPair`: `toStorage` for writes/filters, `fromStorage` for reads
   * - `undefined`: no formatting needed
   *
   * This avoids per-value method dispatch — only fields that need formatting
   * get a formatter function, and the generic layer skips fields without one.
   *
   * Example: MySQL returns a pair for TIMESTAMP-mapped fields (epoch ms ↔ datetime string).
   */
  formatValue?(
    field: TDbFieldMeta,
  ): TValueFormatterPair | ((value: unknown) => unknown) | undefined;
}
