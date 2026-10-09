import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { AtscriptDbTable } from "./db-table";
import { AtscriptDbView, isViewType } from "./db-view";
import type { AtscriptDbReadable } from "./db-readable";
import { aliasTargetOf } from "./view-source";
import type { BaseDbAdapter } from "../base-adapter";
import { aggregateFailure, spaceClosedError } from "../db-error";
import { DbEncryption, type TDbEncryptionOptions } from "../encryption";
import type { TGenericLogger } from "../logger";
import { NoopLogger } from "../logger";
import type { TCascadeTarget, TFkLookupTarget, TReferencingForeignKey } from "../types";

/**
 * Adapter factory function. Called once per table/view to create a fresh adapter instance.
 * Each readable gets its own adapter (1:1 relationship required by BaseDbAdapter).
 */
export type TAdapterFactory = () => BaseDbAdapter;

/** Options bag for {@link DbSpace} (second constructor argument). */
export interface TDbSpaceOptions {
  /** Logger shared by all tables/views in the space. */
  logger?: TGenericLogger;
  /** Field-level encryption configuration for `@db.encrypted` fields. */
  encryption?: TDbEncryptionOptions;
  /**
   * Runs once from {@link DbSpace.close}, after every adapter was disposed.
   * Pass the resource the space does not own by itself, e.g.
   * `() => driver.close()`. The `createAdapter` helpers of the adapter
   * packages set it to close the driver they built.
   * @since 0.1.148
   */
  onClose?: () => void | Promise<void>;
}

/**
 * A `@db.alias` type only names a join scope inside a view definition — it
 * is never a table or view of its own (since 0.1.141).
 */
function assertNotAlias(type: TAtscriptAnnotatedType): void {
  const target = aliasTargetOf(type);
  if (target) {
    throw new Error(
      `"${type.id ?? ""}" is a @db.alias of "${target.id ?? ""}" — a join scope, not a table or view; register "${target.id ?? ""}" instead`,
    );
  }
}

interface TWeakMapOf<V> {
  has(key: TAtscriptAnnotatedType): boolean;
  get(key: TAtscriptAnnotatedType): V | undefined;
  set(key: TAtscriptAnnotatedType, value: V): void;
}

/**
 * A database space — a registry of tables and views sharing the same adapter type and driver.
 *
 * `DbSpace` solves the cross-table discovery problem: when table A has a relation
 * to table B, it needs to find and query table B. The space acts as the registry
 * that makes this possible via the table resolver callback.
 *
 * Each table/view gets its own adapter instance (created by the factory), but all
 * share the same space and can discover each other for `$with` relation loading.
 *
 * ```typescript
 * // SQLite
 * const driver = new BetterSqlite3Driver(':memory:')
 * const db = new DbSpace(() => new SqliteAdapter(driver))
 * const users = db.getTable(UsersType)
 * const activeUsers = db.getView(ActiveUsersType)
 * ```
 */
export class DbSpace implements AsyncDisposable {
  /** `await using` support — an alias for {@link close}, installed below where the runtime has the symbol. */
  declare [Symbol.asyncDispose]: () => Promise<void>;

  private _readables = new WeakMap() as TWeakMapOf<AtscriptDbReadable>;

  /** All tables created in this space — used for reverse FK lookup during cascade. */
  private _allTables = new Set<AtscriptDbTable>();

  /**
   * Per-table-name memo of {@link _getCascadeTargets} / {@link _getFkLookupTarget}
   * (since 0.1.151) — both scan every table; cleared whenever a table is added.
   */
  private _cascadeTargets = new Map<string, TCascadeTarget[]>();
  private _fkLookupTargets = new Map<string, TFkLookupTarget | undefined>();

  /** Every table / view handle the space created — flagged closed on {@link close}. */
  private _handles = new Set<AtscriptDbReadable>();

  /** Lazily created adapter for administrative ops (drop table/view) that don't need a registered readable. */
  private _adminAdapter?: BaseDbAdapter;

  /** Every adapter this space created (tables, views, admin) — disposed on close. */
  private _adapters = new Set<BaseDbAdapter>();

  private _onClose?: () => void | Promise<void>;
  private _closing?: Promise<void>;

  protected readonly logger: TGenericLogger;

  /** Encryption service for `@db.encrypted` fields — validated eagerly at construction. */
  protected readonly _encryption?: DbEncryption;

  /**
   * @param adapterFactory - Creates a fresh adapter per table/view.
   * @param loggerOrOptions - Either a logger (legacy signature) or a
   *   {@link TDbSpaceOptions} bag carrying `logger` and/or `encryption`.
   */
  constructor(
    protected readonly adapterFactory: TAdapterFactory,
    loggerOrOptions?: TGenericLogger | TDbSpaceOptions,
  ) {
    if (loggerOrOptions && typeof (loggerOrOptions as TGenericLogger).error === "function") {
      this.logger = loggerOrOptions as TGenericLogger;
    } else {
      const options = (loggerOrOptions ?? {}) as TDbSpaceOptions;
      this.logger = options.logger ?? NoopLogger;
      this._onClose = options.onClose;
      if (options.encryption) {
        this._encryption = new DbEncryption(options.encryption);
      }
    }
  }

  /**
   * Auto-detects whether the type is a table or view and returns the
   * appropriate instance. Uses `@db.view` or `@db.view.for` presence to distinguish.
   */
  get<T extends TAtscriptAnnotatedType>(type: T, logger?: TGenericLogger): AtscriptDbReadable<T> {
    this._assertOpen();
    if (isViewType(type)) {
      return this.getView(type, logger);
    }
    return this.getTable(type, logger);
  }

  /**
   * Returns the table for the given annotated type.
   * Creates the table + adapter on first access, caches for subsequent calls.
   */
  getTable<T extends TAtscriptAnnotatedType>(type: T, logger?: TGenericLogger): AtscriptDbTable<T> {
    this._assertOpen();
    let readable = this._readables.get(type) as AtscriptDbTable<T> | undefined;
    if (!readable) {
      assertNotAlias(type);
      const adapter = this._createAdapter();
      readable = new AtscriptDbTable<T>(
        type,
        adapter as any,
        logger || this.logger,
        (t) => this.get(t) as any,
        (t) => {
          const resolved = this.get(t);
          return resolved instanceof AtscriptDbTable ? (resolved as any) : undefined;
        },
      );
      this._allTables.add(readable as AtscriptDbTable);
      this._cascadeTargets.clear();
      this._fkLookupTargets.clear();
      readable.setCascadeResolver((tableName) => this._getCascadeTargets(tableName));
      readable.setFkLookupResolver((tableName) => this._getFkLookupTarget(tableName));
      readable.setEncryption(this._encryption);
      this._readables.set(type, readable as AtscriptDbReadable);
      this._handles.add(readable as AtscriptDbReadable);
    }
    return readable as AtscriptDbTable<T>;
  }

  /**
   * Returns the view for the given annotated type.
   * Creates the view + adapter on first access, caches for subsequent calls.
   */
  getView<T extends TAtscriptAnnotatedType>(type: T, logger?: TGenericLogger): AtscriptDbView<T> {
    this._assertOpen();
    let readable = this._readables.get(type) as AtscriptDbView<T> | undefined;
    if (!readable) {
      assertNotAlias(type);
      const adapter = this._createAdapter();
      readable = new AtscriptDbView<T>(
        type,
        adapter as any,
        logger || this.logger,
        (t) => this.get(t) as any,
      );
      readable.setEncryption(this._encryption);
      this._readables.set(type, readable as AtscriptDbReadable);
      this._handles.add(readable as AtscriptDbReadable);
    }
    return readable as AtscriptDbView<T>;
  }

  /**
   * Returns the adapter for the given annotated type.
   * Creates the table/view + adapter on first access if needed.
   */
  getAdapter(type: TAtscriptAnnotatedType): BaseDbAdapter {
    this._assertOpen();
    const readable = this.get(type);
    return readable.dbAdapter;
  }

  /**
   * Drops a table by name. Used by schema sync to remove tables no longer in the schema.
   * See `BaseDbAdapter.dropTableByName` for an adapter that does not support it.
   */
  async dropTableByName(tableName: string): Promise<void> {
    this._assertOpen();
    await this._getAdminAdapter().dropTableByName(tableName);
  }

  /**
   * Drops a view by name. Used by schema sync to remove views no longer in the schema.
   * See `BaseDbAdapter.dropViewByName` for an adapter that does not support it.
   */
  async dropViewByName(viewName: string): Promise<void> {
    this._assertOpen();
    await this._getAdminAdapter().dropViewByName(viewName);
  }

  /**
   * Drops a group of mutually referencing tables as one operation.
   * Used by schema sync to remove a foreign-key cycle no longer in the schema.
   * @since 0.1.128
   */
  async dropTablesByName(tableNames: string[]): Promise<void> {
    this._assertOpen();
    await this._getAdminAdapter().dropTablesByName(tableNames);
  }

  /**
   * Live foreign keys referencing `tableName`, or `undefined` when the
   * adapter cannot introspect them. Used by schema sync for drop ordering
   * and surviving-reference checks of tables without a registered readable.
   * @since 0.1.128
   */
  async getReferencingForeignKeys(
    tableName: string,
  ): Promise<TReferencingForeignKey[] | undefined> {
    this._assertOpen();
    const adapter = this._getAdminAdapter();
    return adapter.getReferencingForeignKeys?.(tableName);
  }

  /**
   * A factory-fresh adapter with NO registered readable. Only the name-taking
   * primitives may run on it (`dropTableByName`, `dropViewByName`,
   * `dropTablesByName`, `getReferencingForeignKeys`) — adapters derive the
   * schema for those from the driver/connection, not from a bound table.
   */
  private _getAdminAdapter(): BaseDbAdapter {
    return (this._adminAdapter ??= this._createAdapter());
  }

  /**
   * A factory-fresh adapter that knows its space (see `BaseDbAdapter.registerSpace`).
   * Optional call: an adapter built against an older `@atscript/db` copy lacks it.
   */
  private _createAdapter(): BaseDbAdapter {
    const adapter = this.adapterFactory();
    (adapter as Partial<Pick<BaseDbAdapter, "registerSpace">>).registerSpace?.(this);
    this._adapters.add(adapter);
    return adapter;
  }

  /** `true` once {@link close} was called. @since 0.1.148 */
  get closed(): boolean {
    return this._closing !== undefined;
  }

  /** Throws `SPACE_CLOSED` once the space is closed. */
  private _assertOpen(): void {
    if (this._closing) throw spaceClosedError();
  }

  /**
   * Closes the space: marks it closed, disposes every adapter it created, then
   * runs the `onClose` hook (the `createAdapter` helpers close their driver
   * there). Idempotent — every call returns the first call's promise. Every
   * step is attempted; failures are collected into an `AggregateError`.
   *
   * It does not cancel or drain in-flight queries: call it after the server
   * stopped accepting requests. After close, `get*` and operations on existing
   * table/view handles throw `DbError("SPACE_CLOSED")`.
   * @since 0.1.148
   */
  close(): Promise<void> {
    return (this._closing ??= this._doClose());
  }

  private async _doClose(): Promise<void> {
    for (const readable of this._handles) readable._spaceClosed = true;
    const errors: unknown[] = [];
    for (const adapter of this._adapters) {
      try {
        await adapter.dispose?.();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this._onClose?.();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw aggregateFailure("DbSpace close failed", errors);
    }
  }

  /**
   * Finds all child tables with FKs pointing to the given parent table name.
   * Accesses `table.foreignKeys` which triggers `_flatten()` if needed.
   */
  private _getCascadeTargets(tableName: string): TCascadeTarget[] {
    let targets = this._cascadeTargets.get(tableName);
    if (targets === undefined) {
      targets = this._scanCascadeTargets(tableName);
      this._cascadeTargets.set(tableName, targets);
    }
    return targets;
  }

  private _scanCascadeTargets(tableName: string): TCascadeTarget[] {
    const targets: TCascadeTarget[] = [];
    for (const table of this._allTables) {
      for (const fk of table.foreignKeys.values()) {
        if (fk.targetTable === tableName && fk.onDelete) {
          targets.push({
            fk,
            childTable: table.tableName,
            deleteMany: (filter) => table.deleteMany(filter as any),
            updateMany: (filter, data) => table.updateMany(filter as any, data as any),
            count: (filter) => table.count({ filter: filter as any }),
          });
        }
      }
    }
    return targets;
  }

  /**
   * Resolves a table name to a queryable target for FK validation.
   * Searches all registered tables for one with the matching table name.
   */
  private _getFkLookupTarget(tableName: string): TFkLookupTarget | undefined {
    if (this._fkLookupTargets.has(tableName)) {
      return this._fkLookupTargets.get(tableName);
    }
    const target = this._scanFkLookupTarget(tableName);
    this._fkLookupTargets.set(tableName, target);
    return target;
  }

  private _scanFkLookupTarget(tableName: string): TFkLookupTarget | undefined {
    for (const table of this._allTables) {
      if (table.tableName === tableName) {
        return {
          count: (filter) => table.count({ filter: filter as any }),
        };
      }
    }
    return undefined;
  }
}

// `await using space = createAdapter(...)` — only where the runtime defines the symbol.
if (typeof Symbol.asyncDispose === "symbol") {
  DbSpace.prototype[Symbol.asyncDispose] = function (this: DbSpace) {
    return this.close();
  };
}
