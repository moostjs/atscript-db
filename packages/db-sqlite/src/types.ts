/**
 * Result of a SQL statement that modifies data (INSERT, UPDATE, DELETE).
 */
export interface TSqliteRunResult {
  /** Number of rows changed by the statement. */
  changes: number;
  /** Rowid of the last inserted row (for INSERT statements). */
  lastInsertRowid: number | bigint;
}

/**
 * Minimal driver interface for SQLite engines.
 *
 * Intentionally synchronous — SQLite is an embedded engine with no network I/O.
 * Both `better-sqlite3` and `node:sqlite` (DatabaseSync) are synchronous.
 * The {@link SqliteAdapter} wraps these calls in promises for the async
 * {@link BaseDbAdapter} contract.
 *
 * For async drivers (e.g., `sql.js`), create a synchronous wrapper
 * or implement a custom adapter.
 */
export interface TSqliteDriver {
  /**
   * Execute a SQL statement that doesn't return rows.
   * Used for INSERT, UPDATE, DELETE, CREATE, DROP, etc.
   */
  run(sql: string, params?: unknown[]): TSqliteRunResult;

  /**
   * Execute a query and return all matching rows.
   */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];

  /**
   * Execute a query and return the first matching row, or null.
   */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null;

  /**
   * Execute raw SQL without returning results.
   * Used for multi-statement strings like PRAGMA or BEGIN/COMMIT.
   */
  exec(sql: string): void;

  /**
   * Close the database connection.
   */
  close(): void;
}
