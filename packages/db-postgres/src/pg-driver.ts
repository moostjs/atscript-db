import type { TGenericLogger } from "@atscript/db";

import type { TPgConnection, TPgDriver, TPgRunResult } from "./types";

const NO_PARAMS: unknown[] = [];

/**
 * pg rejects `undefined` in bind arrays — coerce to `null`. Copies only when
 * there is one (an array hole counts): the common case binds `params` as is
 * (pg never mutates the bind array).
 */
export function sanitizeParams(params?: unknown[]): unknown[] {
  if (!params) {
    return NO_PARAMS;
  }
  return params.includes(undefined)
    ? Array.from(params, (v) => (v === undefined ? null : v))
    : params;
}

// ── Per-pool type parsers ──────────────────────────────────────────────────

/** Parses TIMESTAMPTZ (its text carries the UTC offset) to epoch milliseconds. */
function parseTimestamp(val: string): number | string {
  const ms = new Date(val).getTime();
  return Number.isNaN(ms) ? val : ms;
}

/** PostgreSQL's text form of a `timestamp without time zone` (AD, finite): `YYYY-MM-DD HH:MM:SS[.ffffff]`. */
const TIMESTAMP_TEXT = /^(\d{4,})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?$/;

/**
 * Parses TIMESTAMP (without time zone) to epoch milliseconds, reading the
 * wall time as UTC — the same instant whatever the process time zone (since
 * 0.1.151; it used to be the process's local time). Matches the MySQL
 * adapter's DATETIME reading. Sub-millisecond digits are truncated; other
 * forms (`infinity`, BC dates) keep the previous parse.
 */
export function parseTimestampUtc(val: string): number | string {
  const m = TIMESTAMP_TEXT.exec(val);
  if (!m) {
    return parseTimestamp(val);
  }
  const d = new Date(0);
  // setUTCFullYear: years 0–99 stay literal (Date.UTC would map them to 19xx)
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setUTCHours(
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0,
  );
  const ms = d.getTime();
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
 * - TIMESTAMPTZ → epoch milliseconds (number); TIMESTAMP → epoch ms of its
 *   wall time read as UTC (independent of the process time zone)
 * - NUMERIC → number (not string)
 * - INT8/BIGINT → number (for JS-safe range)
 */
function createCustomTypes(pgTypes: typeof import("pg").types): import("pg").CustomTypesConfig {
  const overrides = new Map<number, (val: string) => unknown>([
    [TIMESTAMP_OID, parseTimestampUtc],
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

/** Options of {@link PgDriver}. */
export interface TPgDriverOptions {
  /**
   * Receives a warning when a pool connection breaks — a terminated backend,
   * failover or network reset (default `console`). See {@link PgDriver}.
   */
  logger?: Pick<TGenericLogger, "warn">;
}

/** The warning logged for a pool client whose connection broke (`57P01`, `ECONNRESET`, …). */
function lostConnectionMessage(err: Error, where: string): string {
  const code = (err as { code?: string }).code ?? err.name;
  return `[atscript/db-postgres] ${where} pool connection lost (${code}): ${err.message}`;
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
 * A broken pool connection (a terminated backend, failover, network reset) is
 * logged through `options.logger` instead of crashing the process (since
 * 0.1.154): idle clients of a pool the driver creates, and clients checked out
 * for a transaction. A pre-created `pg.Pool` is the caller's — attach your own
 * `pool.on('error', …)` listener, or an idle client's error crashes the process.
 *
 * Requires `pg` to be installed:
 * ```bash
 * pnpm add pg
 * ```
 */
export class PgDriver implements TPgDriver {
  private pool: import("pg").Pool | undefined;
  private poolInit: Promise<import("pg").Pool> | undefined;
  private readonly logger: Pick<TGenericLogger, "warn">;

  constructor(
    poolOrConfig: string | import("pg").Pool | import("pg").PoolConfig,
    options: TPgDriverOptions = {},
  ) {
    this.logger = options.logger ?? console;
    if (typeof poolOrConfig === "object" && typeof (poolOrConfig as any).query === "function") {
      // Pre-created Pool instance — use as-is.
      // Note: type parsing and the pool's 'error' listener are the caller's
      // responsibility for pre-created pools.
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
        // An idle client's error (terminated backend, failover, network reset)
        // is re-emitted on the pool, which throws with no listener. The pool
        // has already discarded the client; the next query opens a fresh one.
        this.pool.on("error", (err) => this.logger.warn(lostConnectionMessage(err, "idle")));
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
    // A checked-out client emits its connection errors itself (pg-pool only
    // listens while it is idle): without a listener, a backend terminated
    // between two statements of a transaction would crash the process. Its
    // later statements reject; release() hands the error back so the pool
    // discards the client.
    let lost: Error | undefined;
    const onError = (err: Error): void => {
      if (lost) return;
      lost = err;
      this.logger.warn(lostConnectionMessage(err, "checked-out"));
    };
    client.on("error", onError);
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
        client.removeListener("error", onError);
        client.release(lost);
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
