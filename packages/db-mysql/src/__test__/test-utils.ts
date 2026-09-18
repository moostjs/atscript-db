import path from "path";

import { vi } from "vite-plus/test";
import { prepareFixtures as prepare } from "@atscript/typescript/test-utils";
import dbPlugin from "@atscript/db/plugin";
import MysqlPlugin from "../plugin/index";
import type { TMysqlDriver, TMysqlConnection, TMysqlRunResult } from "../types";

export async function prepareFixtures() {
  const fixturesDir = path.join(path.dirname(import.meta.url.slice(7)), "fixtures");
  await prepare({
    rootDir: fixturesDir,
    plugins: [dbPlugin(), MysqlPlugin()],
  });
}

// ── Mock driver ──────────────────────────────────────────────────────────────

export interface CapturedCall {
  /** Issued through the pool (`driver.*`) or on a dedicated connection (`getConnection()`). */
  via: "pool" | "conn";
  method: "run" | "all" | "get" | "exec";
  sql: string;
  params?: unknown[];
}

export interface TMockDriverOptions {
  runResult?: Partial<TMysqlRunResult>;
  /** Result of every `all` (unless a canned `all` entry matches). */
  allResult?: unknown[];
  /** Result of every `get` (unless a canned `get` entry matches). */
  getResult?: unknown;
  /** Canned `all` results by SQL substring — first match wins. */
  all?: Array<[substring: string, rows: unknown[]]>;
  /** Canned `get` results by SQL substring — first match wins. */
  get?: Array<[substring: string, row: unknown]>;
}

/**
 * Creates a mock MySQL driver that captures all SQL calls.
 * Both pool-level and connection-level calls are recorded in `calls` (tagged
 * `via`); `releaseCount()` counts released dedicated connections.
 */
export function createMockDriver(
  overrides?: TMockDriverOptions,
): TMysqlDriver & { calls: CapturedCall[]; releaseCount: () => number } {
  const calls: CapturedCall[] = [];
  let released = 0;

  const runResult: TMysqlRunResult = {
    affectedRows: 1,
    insertId: 1,
    changedRows: 1,
    ...overrides?.runResult,
  };
  const pick = <T>(table: Array<[string, T]> | undefined, sql: string): T | undefined =>
    table?.find(([s]) => sql.includes(s))?.[1];

  const make = (via: CapturedCall["via"]) => ({
    async run(sql: string, params?: unknown[]): Promise<TMysqlRunResult> {
      calls.push({ via, method: "run", sql, params });
      return runResult;
    },
    async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
      calls.push({ via, method: "all", sql, params });
      return (pick(overrides?.all, sql) ?? overrides?.allResult ?? []) as T[];
    },
    async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
      calls.push({ via, method: "get", sql, params });
      return (pick(overrides?.get, sql) ?? overrides?.getResult ?? null) as T | null;
    },
    async exec(sql: string): Promise<void> {
      calls.push({ via, method: "exec", sql });
    },
  });

  return {
    calls,
    releaseCount: () => released,
    ...make("pool"),
    async getConnection(): Promise<TMysqlConnection> {
      return {
        ...make("conn"),
        release: vi.fn(() => {
          released++;
        }),
      };
    },
    async close(): Promise<void> {},
  };
}
