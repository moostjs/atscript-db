import type { TPgConnection, TPgDriver, TPgRunResult } from "./types";

/** pg rejects `undefined` in bind arrays — coerce to `null`. */
function sanitizeParams(params?: unknown[]): unknown[] {
  if (!params) {
    return [];
  }
  return params.map((v) => (v === undefined ? null : v));
}

// ── Per-pool type parsers ──────────────────────────────────────────────────

/** Parses TIMESTAMP/TIMESTAMPTZ to epoch milliseconds. */
function parseTimestamp(val: string): number | string {
  const ms = new Date(val).getTime();
  return Number.isNaN(ms) ? val : ms;
}

/** Parses NUMERIC to number. */
function parseNumeric(val: string): number | string {
  const n = Number.parseFloat(val);
  return Number.isNaN(n) ? val : n;
}

/** Parses INT8/BIGINT to number. Returns string if value exceeds safe integer range. */
function parseBigInt(val: string): number | string {
  const n = Number.parseInt(val, 10);
  return Number.isNaN(n) || !Number.isSafeInteger(n) ? val : n;
}

/** OIDs for types we override. */
const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;
const NUMERIC_OID = 1700;
const INT8_OID = 20;

/**
 * Creates a per-pool custom types config that overrides specific parsers
 * without mutating the global `pg.types`.
 *
 * - TIMESTAMP/TIMESTAMPTZ → epoch milliseconds (number)
 * - NUMERIC → number (not string)
 * - INT8/BIGINT → number (for JS-safe range)
 */
function createCustomTypes(pgTypes: typeof import("pg").types): import("pg").CustomTypesConfig {
  const overrides = new Map<number, (val: string) => unknown>([
    [TIMESTAMP_OID, parseTimestamp],
    [TIMESTAMPTZ_OID, parseTimestamp],
    [NUMERIC_OID, parseNumeric],
    [INT8_OID, parseBigInt],
  ]);
  return {
    getTypeParser(oid: number, format?: string): any {
      const custom = overrides.get(oid);
      if (custom) {
        return custom;
      }
      return pgTypes.getTypeParser(oid, format as any);
    },
  };
}

/**
 * {@link TPgDriver} implementation backed by `pg` (node-postgres).
 *
 * Accepts a connection URI string, a `pg.PoolConfig` object, or a pre-created
 * `pg.Pool` instance.
 *
 * ```typescript
 * import { PgDriver } from '@atscript/db-postgres'
 *
 * // Connection URI
 * const driver = new PgDriver('postgresql://user:pass@localhost:5432/mydb')
 *
 * // Pool options
 * const driver = new PgDriver({
 *   host: 'localhost',
 *   user: 'postgres',
 *   database: 'mydb',
 *   max: 10,
 * })
 *
 * // Pre-created pool
 * import pg from 'pg'
 * const pool = new pg.Pool({ connectionString: '...' })
 * const driver = new PgDriver(pool)
 * ```
 *
 * Requires `pg` to be installed:
 * ```bash
 * pnpm add pg
 * ```
 */
export class PgDriver implements TPgDriver {
  private pool: import("pg").Pool | undefined;
  private poolInit: Promise<import("pg").Pool> | undefined;

  constructor(poolOrConfig: string | import("pg").Pool | import("pg").PoolConfig) {
    if (typeof poolOrConfig === "object" && typeof (poolOrConfig as any).query === "function") {
      // Pre-created Pool instance — use as-is.
      // Note: type parsing is the caller's responsibility for pre-created pools.
      this.pool = poolOrConfig as import("pg").Pool;
    } else {
      // Dynamic import to keep pg optional and support both CJS and ESM
      this.poolInit = import("pg").then((pg) => {
        const Pool = pg.default?.Pool ?? pg.Pool;
        const types = pg.default?.types ?? pg.types;
        const customTypes = types ? createCustomTypes(types) : undefined;
        if (typeof poolOrConfig === "string") {
          this.pool = new Pool({ connectionString: poolOrConfig, types: customTypes });
        } else {
          this.pool = new Pool({
            ...(poolOrConfig as import("pg").PoolConfig),
            types: customTypes,
          });
        }
        return this.pool;
      });
    }
  }

  private getPool(): import("pg").Pool | Promise<import("pg").Pool> {
    return this.pool || this.poolInit!;
  }

  async run(sql: string, params?: unknown[]): Promise<TPgRunResult> {
    const pool = await this.getPool();
    const result = await pool.query(sql, sanitizeParams(params));
    return {
      affectedRows: result.rowCount ?? 0,
      rows: result.rows ?? [],
    };
  }

  async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const pool = await this.getPool();
    const result = await pool.query(sql, sanitizeParams(params));
    return result.rows as T[];
  }

  async get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const pool = await this.getPool();
    const result = await pool.query(sql, sanitizeParams(params));
    return (result.rows as T[])[0] ?? null;
  }

  async exec(sql: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(sql);
  }

  async getConnection(): Promise<TPgConnection> {
    const pool = await this.getPool();
    const client = await pool.connect();
    return {
      async run(sql: string, params?: unknown[]): Promise<TPgRunResult> {
        const result = await client.query(sql, sanitizeParams(params));
        return {
          affectedRows: result.rowCount ?? 0,
          rows: result.rows ?? [],
        };
      },
      async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        const result = await client.query(sql, sanitizeParams(params));
        return result.rows as T[];
      },
      async get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
        const result = await client.query(sql, sanitizeParams(params));
        return (result.rows as T[])[0] ?? null;
      },
      async exec(sql: string): Promise<void> {
        await client.query(sql);
      },
      release() {
        client.release();
      },
    };
  }

  async close(): Promise<void> {
    const pool = await this.getPool();
    await pool.end();
  }
}
