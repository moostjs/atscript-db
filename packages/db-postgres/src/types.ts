/**
 * Result of a PostgreSQL statement that modifies data (INSERT, UPDATE, DELETE).
 */
export interface TPgRunResult {
  /** Number of rows affected by the statement. */
  affectedRows: number;
  /** Rows returned by a RETURNING clause (empty array when not applicable). */
  rows: Record<string, unknown>[];
}

/**
 * Async driver interface for PostgreSQL engines.
 *
 * The driver has two modes of operation:
 * 1. **Pool mode** (default) — each call acquires/releases a connection automatically
 * 2. **Connection mode** (for transactions) — a dedicated connection is acquired
 *    and all operations run on it until released
 *
 * Implementations: {@link PgDriver}
 */
export interface TPgDriver {
  /**
   * Execute a SQL statement that modifies data (INSERT, UPDATE, DELETE, DDL).
   * Uses parameterized queries (`$1, $2, ...` placeholders).
   */
  run(sql: string, params?: unknown[]): Promise<TPgRunResult>;

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
   * Used for DDL, SET statements, etc.
   */
  exec(sql: string): Promise<void>;

  /**
   * Acquire a dedicated connection for transaction use.
   * Returns a {@link TPgConnection} that must be released after use.
   */
  getConnection(): Promise<TPgConnection>;

  /**
   * Close the pool / end all connections.
   */
  close(): Promise<void>;
}

/**
 * A dedicated connection acquired from the pool.
 * Used for transactions where all operations must run on the same connection.
 */
export interface TPgConnection {
  /** Execute a statement that modifies data. */
  run(sql: string, params?: unknown[]): Promise<TPgRunResult>;
  /** Execute a query and return all matching rows. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Execute a query and return the first matching row, or null. */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Execute raw SQL without returning results. */
  exec(sql: string): Promise<void>;
  /** Release this connection back to the pool. */
  release(): void;
}
