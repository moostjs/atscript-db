/**
 * Result of a MySQL statement that modifies data (INSERT, UPDATE, DELETE).
 */
export interface TMysqlRunResult {
  /** Number of rows affected by the statement. */
  affectedRows: number;
  /** Auto-generated ID from last INSERT (0 if not applicable). */
  insertId: number | bigint;
  /** Number of rows changed by an UPDATE (differs from affectedRows when row matches but value unchanged). */
  changedRows: number;
}

/**
 * Async driver interface for MySQL engines.
 *
 * Unlike SQLite's synchronous driver, MySQL is network-based
 * and requires async operations throughout.
 *
 * The driver has two modes of operation:
 * 1. **Pool mode** (default) — each call acquires/releases a connection automatically
 * 2. **Connection mode** (for transactions) — a dedicated connection is acquired
 *    and all operations run on it until released
 *
 * Implementations: {@link Mysql2Driver}
 */
export interface TMysqlDriver {
  /**
   * Execute a SQL statement that modifies data (INSERT, UPDATE, DELETE, DDL).
   * Uses parameterized queries (`?` placeholders).
   */
  run(sql: string, params?: unknown[]): Promise<TMysqlRunResult>;

  /**
   * Execute a query and return all matching rows.
   */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Execute a query and return the first matching row, or null.
   */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;

  /**
   * Execute raw SQL without returning results.
   * Used for DDL, SET statements, multi-statement strings, etc.
   */
  exec(sql: string): Promise<void>;

  /**
   * Acquire a dedicated connection for transaction use.
   * Returns a {@link TMysqlConnection} that must be released after use.
   */
  getConnection(): Promise<TMysqlConnection>;

  /**
   * Close the pool / end all connections.
   */
  close(): Promise<void>;
}

/**
 * A dedicated connection acquired from the pool.
 * Used for transactions where all operations must run on the same connection.
 */
export interface TMysqlConnection {
  /** Execute a statement that modifies data. */
  run(sql: string, params?: unknown[]): Promise<TMysqlRunResult>;
  /** Execute a query and return all matching rows. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Execute a query and return the first matching row, or null. */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Execute raw SQL without returning results. */
  exec(sql: string): Promise<void>;
  /** Release this connection back to the pool. */
  release(): void;
}
