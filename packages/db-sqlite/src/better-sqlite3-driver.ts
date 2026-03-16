import { createRequire } from "node:module";
import type { TSqliteDriver, TSqliteRunResult } from "./types";

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
 */
export class BetterSqlite3Driver implements TSqliteDriver {
  private db: import("better-sqlite3").Database;

  constructor(
    pathOrDb: string | import("better-sqlite3").Database,
    options?: Record<string, unknown>,
  ) {
    if (typeof pathOrDb === "string") {
      // Use createRequire to support both CJS and ESM environments
      const req = createRequire(import.meta.url);
      const Database = req("better-sqlite3") as typeof import("better-sqlite3");
      this.db = new (Database as any)(pathOrDb, options);
    } else {
      this.db = pathOrDb;
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
