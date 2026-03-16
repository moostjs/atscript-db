import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { AtscriptDbTable } from "./db-table";
import { AtscriptDbView } from "./db-view";
import type { AtscriptDbReadable } from "./db-readable";
import type { BaseDbAdapter } from "../base-adapter";
import type { TGenericLogger } from "../logger";
import { NoopLogger } from "../logger";
import type { TCascadeTarget, TFkLookupTarget } from "../types";

/**
 * Adapter factory function. Called once per table/view to create a fresh adapter instance.
 * Each readable gets its own adapter (1:1 relationship required by BaseDbAdapter).
 */
export type TAdapterFactory = () => BaseDbAdapter;

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
export class DbSpace {
  private _readables = new WeakMap() as TWeakMapOf<AtscriptDbReadable>;

  /** All tables created in this space — used for reverse FK lookup during cascade. */
  private _allTables = new Set<AtscriptDbTable>();

  /** Lazily created adapter for administrative ops (drop table/view) that don't need a registered readable. */
  private _adminAdapter?: BaseDbAdapter;

  constructor(
    protected readonly adapterFactory: TAdapterFactory,
    protected readonly logger: TGenericLogger = NoopLogger,
  ) {}

  /**
   * Auto-detects whether the type is a table or view and returns the
   * appropriate instance. Uses `@db.view` or `@db.view.for` presence to distinguish.
   */
  get<T extends TAtscriptAnnotatedType>(type: T, logger?: TGenericLogger): AtscriptDbReadable<T> {
    if (type.metadata.has("db.view") || type.metadata.has("db.view.for")) {
      return this.getView(type, logger);
    }
    return this.getTable(type, logger);
  }

  /**
   * Returns the table for the given annotated type.
   * Creates the table + adapter on first access, caches for subsequent calls.
   */
  getTable<T extends TAtscriptAnnotatedType>(type: T, logger?: TGenericLogger): AtscriptDbTable<T> {
    let readable = this._readables.get(type) as AtscriptDbTable<T> | undefined;
    if (!readable) {
      const adapter = this.adapterFactory();
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
      readable.setCascadeResolver((tableName) => this._getCascadeTargets(tableName));
      readable.setFkLookupResolver((tableName) => this._getFkLookupTarget(tableName));
      this._readables.set(type, readable as AtscriptDbReadable);
    }
    return readable as AtscriptDbTable<T>;
  }

  /**
   * Returns the view for the given annotated type.
   * Creates the view + adapter on first access, caches for subsequent calls.
   */
  getView<T extends TAtscriptAnnotatedType>(type: T, logger?: TGenericLogger): AtscriptDbView<T> {
    let readable = this._readables.get(type) as AtscriptDbView<T> | undefined;
    if (!readable) {
      const adapter = this.adapterFactory();
      readable = new AtscriptDbView<T>(
        type,
        adapter as any,
        logger || this.logger,
        (t) => this.get(t) as any,
      );
      this._readables.set(type, readable as AtscriptDbReadable);
    }
    return readable as AtscriptDbView<T>;
  }

  /**
   * Returns the adapter for the given annotated type.
   * Creates the table/view + adapter on first access if needed.
   */
  getAdapter(type: TAtscriptAnnotatedType): BaseDbAdapter {
    const readable = this.get(type);
    return readable.dbAdapter;
  }

  /**
   * Drops a table by name. Used by schema sync to remove tables no longer in the schema.
   */
  async dropTableByName(tableName: string): Promise<void> {
    const adapter = this._getAdminAdapter();
    if (adapter.dropTableByName) {
      await adapter.dropTableByName(tableName);
    }
  }

  /**
   * Drops a view by name. Used by schema sync to remove views no longer in the schema.
   */
  async dropViewByName(viewName: string): Promise<void> {
    const adapter = this._getAdminAdapter();
    if (adapter.dropViewByName) {
      await adapter.dropViewByName(viewName);
    }
  }

  private _getAdminAdapter(): BaseDbAdapter {
    return (this._adminAdapter ??= this.adapterFactory());
  }

  /**
   * Finds all child tables with FKs pointing to the given parent table name.
   * Accesses `table.foreignKeys` which triggers `_flatten()` if needed.
   */
  private _getCascadeTargets(tableName: string): TCascadeTarget[] {
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
