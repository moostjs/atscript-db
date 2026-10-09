import { createRequire } from "node:module";
import type { TSqliteDriver, TSqliteRunResult } from "./types";

export interface TBetterSqlite3DriverOptions extends Record<string, unknown> {
  /** Load the optional `sqlite-vec` extension. */
  vector?: boolean;
  /** Absolute paths to SQLite loadable extensions, passed to `Database.loadExtension`. */
  loadExtensions?: string[];
  /**
   * Max prepared statements kept per connection (least-recently-used evicted).
   * `run` / `all` / `get` reuse the statement prepared for the same SQL text
   * instead of preparing it on every call. Default: 256; `0` disables the cache.
   * @since 0.1.151
   */
  statementCacheSize?: number;
}

type TStatement = import("better-sqlite3").Statement;

const DEFAULT_STATEMENT_CACHE_SIZE = 256;
/** SQL longer than this is prepared per call (long `$in` lists, multi-row inserts). */
const MAX_CACHED_SQL_LENGTH = 8192;
/** Schema introspection (`PRAGMA …`) is never cached: it is cold, and a pragma may bake schema state in at prepare time. */
const PRAGMA_RE = /^\s*pragma\b/i;
/** Transaction-control statements `exec` runs through a statement prepared once. */
const TX_CONTROL_SQL = new Set(["BEGIN", "BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);

/**
 * {@link TSqliteDriver} implementation backed by `better-sqlite3`.
 *
 * Accepts either a file path (opens a new database) or a pre-created
 * `Database` instance from `better-sqlite3`.
 *
 * ```typescript
 * import { BetterSqlite3Driver } from '@atscript/db-sqlite'
 *
 * // In-memory database
 * const driver = new BetterSqlite3Driver(':memory:')
 *
 * // File-based database
 * const driver = new BetterSqlite3Driver('./my-data.db')
 *
 * // With sqlite-vec extension loaded
 * const driver = new BetterSqlite3Driver('./my-data.db', { vector: true })
 *
 * // Pre-created instance
 * import Database from 'better-sqlite3'
 * const db = new Database(':memory:', { verbose: console.log })
 * const driver = new BetterSqlite3Driver(db)
 * ```
 *
 * Requires `better-sqlite3` to be installed:
 * ```bash
 * pnpm add better-sqlite3
 * ```
 *
 * Vector search support requires the optional `sqlite-vec` package:
 * ```bash
 * pnpm add sqlite-vec
 * ```
 */
export class BetterSqlite3Driver implements TSqliteDriver {
  private db: import("better-sqlite3").Database;

  readonly hasVectorExt: boolean = false;

  /** LRU of prepared statements by SQL text (Map insertion order = recency). */
  private readonly _stmts = new Map<string, TStatement>();
  private readonly _maxStmts: number;

  constructor(
    pathOrDb: string | import("better-sqlite3").Database,
    options?: TBetterSqlite3DriverOptions,
  ) {
    const { vector, loadExtensions, statementCacheSize, ...nativeOptions } = options ?? {};
    this._maxStmts = Math.max(0, statementCacheSize ?? DEFAULT_STATEMENT_CACHE_SIZE);
    const req = createRequire(import.meta.url);

    if (typeof pathOrDb === "string") {
      const Database = req("better-sqlite3") as typeof import("better-sqlite3");
      this.db = new (Database as any)(pathOrDb, nativeOptions);
    } else {
      this.db = pathOrDb;
    }

    for (const ext of loadExtensions ?? []) {
      this.db.loadExtension(ext);
    }

    if (vector) {
      const sqliteVec = req("sqlite-vec") as { load(db: unknown): void };
      sqliteVec.load(this.db);
      this.hasVectorExt = true;
    }
  }

  /**
   * The prepared statement for `sql` — reused from the LRU cache when present.
   * A cached statement stays valid across schema changes: SQLite re-prepares
   * it transparently on its next step (and `exec` — the DDL path — clears the
   * cache anyway).
   */
  private _prepare(sql: string): TStatement {
    const cached = this._stmts.get(sql);
    if (cached !== undefined) {
      // Refresh recency (re-insert at the tail).
      this._stmts.delete(sql);
      this._stmts.set(sql, cached);
      return cached;
    }
    const stmt = this.db.prepare(sql);
    if (this._maxStmts > 0 && sql.length <= MAX_CACHED_SQL_LENGTH && !PRAGMA_RE.test(sql)) {
      this._stmts.set(sql, stmt);
      if (this._stmts.size > this._maxStmts) {
        this._stmts.delete(this._stmts.keys().next().value as string);
      }
    }
    return stmt;
  }

  run(sql: string, params?: unknown[]): TSqliteRunResult {
    const stmt = this._prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    const stmt = this._prepare(sql);
    return (params ? stmt.all(...params) : stmt.all()) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    const stmt = this._prepare(sql);
    return ((params ? stmt.get(...params) : stmt.get()) as T) ?? null;
  }

  exec(sql: string): void {
    if (TX_CONTROL_SQL.has(sql)) {
      // BEGIN / COMMIT / ROLLBACK go through the statement cache too.
      this._prepare(sql).run();
      return;
    }
    this.db.exec(sql);
    // `exec` carries DDL / PRAGMAs / ATTACH: drop the cached statements
    // (SQLite would re-prepare them anyway; this releases the ones over
    // dropped tables, and `BEGIN IMMEDIATE` locks the databases attached
    // when it was prepared — `ATTACH` does not re-prepare it).
    this._stmts.clear();
  }

  registerFunction(
    name: string,
    fn: (...args: any[]) => unknown,
    opts?: { deterministic?: boolean },
  ): void {
    this.db.function(name, { deterministic: opts?.deterministic ?? false }, fn);
  }

  /** Idempotent: closing an already closed database is a no-op. */
  close(): void {
    this._stmts.clear();
    if (!this.db.open) return;
    this.db.close();
  }
}
