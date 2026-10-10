import type { TMysqlConnection, TMysqlDriver, TMysqlRunResult } from "./types";
import { utcDatetimeToEpochMs } from "./mysql-adapter";

const NO_PARAMS: unknown[] = [];

/**
 * mysql2 rejects `undefined` in bind arrays — coerce to `null`. Copies only
 * when there is one (an array hole counts): the common case binds `params`
 * as is (mysql2 never mutates the bind array).
 */
export function sanitizeParams(params?: unknown[]): unknown[] {
  if (!params) {
    return NO_PARAMS;
  }
  return params.includes(undefined)
    ? Array.from(params, (v) => (v === undefined ? null : v))
    : params;
}

/**
 * Custom type-casting for mysql2 result columns to maintain cross-adapter consistency.
 *
 * - TIMESTAMP/DATETIME → epoch milliseconds (number) instead of Date objects
 * - DECIMAL/NEWDECIMAL → number instead of string
 * - JSON → its text (since 0.1.155), as MariaDB's `LONGTEXT` JSON and SQLite
 *   return it: the relational mapper parses JSON text, so a JSON string value
 *   is not mistaken for JSON text. Done here as well as with `jsonStrings`:
 *   mysql2 caches compiled row parsers per process without keying them by
 *   `jsonStrings`, so another pool's parser could otherwise be reused.
 */
function atscriptTypeCast(field: any, next: () => any): any {
  if (field.type === "JSON") {
    // JSON arrives with the binary charset; its text is UTF-8.
    return field.string("utf8");
  }
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

/** Options of {@link Mysql2Driver}. */
export interface TMysql2DriverOptions {
  /**
   * Add `STRICT_TRANS_TABLES` to the session `sql_mode` of every new pool
   * connection (default `true`, since 0.1.148). The server's own modes are
   * kept — the mode is appended, never replaced. A non-strict server (Amazon
   * RDS defaults to `NO_ENGINE_SUBSTITUTION`) otherwise coerces a `NOT NULL`,
   * out-of-range or too-long value instead of failing the write. Pass `false`
   * to keep the server's `sql_mode` untouched.
   */
  strictMode?: boolean;
}

/** Appends `STRICT_TRANS_TABLES` to the session `sql_mode` unless a strict mode is already set. */
export const ENSURE_STRICT_SQL =
  "SET SESSION sql_mode = IF(FIND_IN_SET('STRICT_TRANS_TABLES', @@SESSION.sql_mode) OR FIND_IN_SET('STRICT_ALL_TABLES', @@SESSION.sql_mode), @@SESSION.sql_mode, CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_TRANS_TABLES'))";

/**
 * Runs {@link ENSURE_STRICT_SQL} once on every connection of the pool: on
 * `connection` for the ones the pool opens, and on `acquire` for a connection
 * opened before the driver was constructed (a pre-used pool). The statement is
 * queued on the connection before the pool hands it out, so it precedes every
 * query; a failure leaves the server's mode in place.
 */
function ensureStrict(pool: import("mysql2/promise").Pool): void {
  // the promise pool forwards `on` to the callback pool: the listener gets the raw connection
  type TRawConn = { query(sql: string, cb: () => void): unknown };
  const raw = pool as unknown as {
    on(event: "connection" | "acquire", listener: (conn: TRawConn) => void): void;
  };
  const seen = new WeakSet<TRawConn>();
  const strict = (conn: TRawConn): void => {
    if (seen.has(conn)) return;
    seen.add(conn);
    conn.query(ENSURE_STRICT_SQL, () => {});
  };
  raw.on("connection", strict);
  raw.on("acquire", strict);
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
 * Every new pool connection gets `STRICT_TRANS_TABLES` appended to its session
 * `sql_mode` (since 0.1.148); pass `{ strictMode: false }` as the second
 * argument to opt out. A pre-created `Pool` is covered too: connections it
 * opened earlier get the statement when they are first acquired through it.
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
    options: TMysql2DriverOptions = {},
  ) {
    const strict = options.strictMode !== false;
    if (typeof poolOrConfig === "object" && "execute" in poolOrConfig) {
      // Pre-created pool instance
      this.pool = poolOrConfig as import("mysql2/promise").Pool;
      if (strict) ensureStrict(this.pool);
    } else {
      // Dynamic import to keep mysql2 optional and support both CJS and ESM
      this.poolInit = import("mysql2/promise").then((mysql) => {
        if (typeof poolOrConfig === "string") {
          this.pool = mysql.createPool({
            uri: poolOrConfig,
            timezone: "+00:00",
            supportBigNumbers: true,
            bigNumberStrings: false,
            jsonStrings: true,
            typeCast: atscriptTypeCast,
          });
        } else {
          this.pool = mysql.createPool({
            ...poolOrConfig,
            timezone: "+00:00",
            supportBigNumbers: true,
            bigNumberStrings: false,
            jsonStrings: true,
            typeCast: atscriptTypeCast,
          });
        }
        if (strict) ensureStrict(this.pool);
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

  private _closing?: Promise<void>;

  /** Idempotent: every call returns the first call's promise. */
  close(): Promise<void> {
    // The pool is created with the driver (eagerly), so closing never builds one.
    return (this._closing ??= Promise.resolve(this.getPool()).then((pool) => pool.end()));
  }
}
