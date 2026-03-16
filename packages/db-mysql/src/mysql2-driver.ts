import type { TMysqlConnection, TMysqlDriver, TMysqlRunResult } from "./types";
import { utcDatetimeToEpochMs } from "./mysql-adapter";

/** mysql2 rejects `undefined` in bind arrays — coerce to `null`. */
function sanitizeParams(params?: unknown[]): unknown[] {
  if (!params) {
    return [];
  }
  return params.map((v) => (v === undefined ? null : v));
}

/**
 * Custom type-casting for mysql2 result columns to maintain cross-adapter consistency.
 *
 * - TIMESTAMP/DATETIME → epoch milliseconds (number) instead of Date objects
 * - DECIMAL/NEWDECIMAL → number instead of string
 */
function atscriptTypeCast(field: any, next: () => any): any {
  if (field.type === "TIMESTAMP" || field.type === "DATETIME") {
    const str = field.string();
    if (str === null) {
      return null;
    }
    return utcDatetimeToEpochMs(str);
  }
  if (field.type === "NEWDECIMAL" || field.type === "DECIMAL") {
    const str = field.string();
    return str === null ? null : Number(str);
  }
  return next();
}

/**
 * {@link TMysqlDriver} implementation backed by `mysql2/promise`.
 *
 * Accepts a connection URI string, a `PoolOptions` object, or a pre-created
 * `Pool` instance from `mysql2/promise`.
 *
 * ```typescript
 * import { Mysql2Driver } from '@atscript/db-mysql'
 *
 * // Connection URI
 * const driver = new Mysql2Driver('mysql://root:pass@localhost:3306/mydb')
 *
 * // Pool options
 * const driver = new Mysql2Driver({
 *   host: 'localhost',
 *   user: 'root',
 *   database: 'mydb',
 *   waitForConnections: true,
 *   connectionLimit: 10,
 * })
 *
 * // Pre-created pool
 * import mysql from 'mysql2/promise'
 * const pool = mysql.createPool({ host: 'localhost', database: 'mydb' })
 * const driver = new Mysql2Driver(pool)
 * ```
 *
 * Requires `mysql2` to be installed:
 * ```bash
 * pnpm add mysql2
 * ```
 */
export class Mysql2Driver implements TMysqlDriver {
  private pool: import("mysql2/promise").Pool | undefined;
  private poolInit: Promise<import("mysql2/promise").Pool> | undefined;

  constructor(
    poolOrConfig: string | import("mysql2/promise").Pool | import("mysql2/promise").PoolOptions,
  ) {
    if (typeof poolOrConfig === "object" && "execute" in poolOrConfig) {
      // Pre-created pool instance
      this.pool = poolOrConfig as import("mysql2/promise").Pool;
    } else {
      // Dynamic import to keep mysql2 optional and support both CJS and ESM
      this.poolInit = import("mysql2/promise").then((mysql) => {
        if (typeof poolOrConfig === "string") {
          this.pool = mysql.createPool({
            uri: poolOrConfig,
            timezone: "+00:00",
            supportBigNumbers: true,
            bigNumberStrings: false,
            typeCast: atscriptTypeCast,
          });
        } else {
          this.pool = mysql.createPool({
            ...poolOrConfig,
            timezone: "+00:00",
            supportBigNumbers: true,
            bigNumberStrings: false,
            typeCast: atscriptTypeCast,
          });
        }
        return this.pool;
      });
    }
  }

  private getPool(): import("mysql2/promise").Pool | Promise<import("mysql2/promise").Pool> {
    return this.pool || this.poolInit!;
  }

  async run(sql: string, params?: unknown[]): Promise<TMysqlRunResult> {
    const pool = await this.getPool();
    const [result] = await pool.query(sql, sanitizeParams(params));
    const header = result as import("mysql2").ResultSetHeader;
    return {
      affectedRows: header.affectedRows ?? 0,
      insertId: header.insertId ?? 0,
      changedRows: header.changedRows ?? 0,
    };
  }

  async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const pool = await this.getPool();
    const [rows] = await pool.query(sql, sanitizeParams(params));
    return rows as T[];
  }

  async get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const pool = await this.getPool();
    const [rows] = await pool.query(sql, sanitizeParams(params));
    return (rows as T[])[0] ?? null;
  }

  async exec(sql: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(sql);
  }

  async getConnection(): Promise<TMysqlConnection> {
    const pool = await this.getPool();
    const conn = await pool.getConnection();
    return {
      async run(sql: string, params?: unknown[]): Promise<TMysqlRunResult> {
        const [result] = await conn.query(sql, sanitizeParams(params));
        const header = result as import("mysql2").ResultSetHeader;
        return {
          affectedRows: header.affectedRows ?? 0,
          insertId: header.insertId ?? 0,
          changedRows: header.changedRows ?? 0,
        };
      },
      async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        const [rows] = await conn.query(sql, sanitizeParams(params));
        return rows as T[];
      },
      async get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
        const [rows] = await conn.query(sql, sanitizeParams(params));
        return (rows as T[])[0] ?? null;
      },
      async exec(sql: string): Promise<void> {
        await conn.query(sql);
      },
      release() {
        conn.release();
      },
    };
  }

  async close(): Promise<void> {
    const pool = await this.getPool();
    await pool.end();
  }
}
