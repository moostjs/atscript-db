import { createRequire } from "node:module";
import type { TSqliteDriver, TSqliteRunResult } from "./types";

export interface TBetterSqlite3DriverOptions extends Record<string, unknown> {
  /** Load the optional `sqlite-vec` extension. */
  vector?: boolean;
  /** Absolute paths to SQLite loadable extensions, passed to `Database.loadExtension`. */
  loadExtensions?: string[];
}

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

  constructor(
    pathOrDb: string | import("better-sqlite3").Database,
    options?: TBetterSqlite3DriverOptions,
  ) {
    const { vector, loadExtensions, ...nativeOptions } = options ?? {};
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

  run(sql: string, params?: unknown[]): TSqliteRunResult {
    const stmt = this.db.prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    return (params ? stmt.all(...params) : stmt.all()) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    const stmt = this.db.prepare(sql);
    return ((params ? stmt.get(...params) : stmt.get()) as T) ?? null;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
