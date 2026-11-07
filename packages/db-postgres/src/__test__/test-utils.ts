import path from "path";

import { expect, vi } from "vite-plus/test";
import { DbError } from "@atscript/db";
import { prepareFixtures as prepare } from "@atscript/typescript/test-utils";
import dbPlugin from "@atscript/db/plugin";
import PostgresPlugin from "../plugin/index";
import type { TPgDriver, TPgConnection, TPgRunResult } from "../types";

export async function prepareFixtures() {
  const fixturesDir = path.join(path.dirname(import.meta.url.slice(7)), "fixtures");
  await prepare({
    rootDir: fixturesDir,
    plugins: [dbPlugin(), PostgresPlugin()],
  });
}

// ── Mock driver ──────────────────────────────────────────────────────────────

export interface CapturedCall {
  method: "run" | "all" | "get" | "exec";
  sql: string;
  params?: unknown[];
}

/**
 * Creates a mock PostgreSQL driver that captures all SQL calls.
 * Both pool-level and connection-level calls are recorded in `calls`.
 */
export function createMockDriver(overrides?: {
  runResult?: Partial<TPgRunResult>;
  /** Per-statement `run()` result (overrides `runResult`). */
  runResponder?: (sql: string, params?: unknown[]) => Partial<TPgRunResult>;
  /** Rows for every `all()` — or a responder keyed on the statement. */
  allResult?: unknown[] | ((sql: string, params?: unknown[]) => unknown[]);
  /** The row for every `get()` — or a responder keyed on the statement. */
  getResult?: Record<string, unknown> | null | ((sql: string, params?: unknown[]) => unknown);
  /** Makes `exec()` throw for the statements it returns an error for. */
  execError?: (sql: string) => Error | undefined;
  /** Hand out the same connection object on every `getConnection()` (a custom pooling driver). */
  reuseConnection?: boolean;
  /** `false`: the connection has no `destroy()` (default: it has one). */
  destroyable?: boolean;
}): TPgDriver & { calls: CapturedCall[]; releaseCount: () => number; destroyCount: () => number } {
  const calls: CapturedCall[] = [];
  let released = 0;
  let destroyed = 0;

  const runResult: TPgRunResult = {
    affectedRows: 1,
    rows: [],
    ...overrides?.runResult,
  };
  const allRows = <T>(sql: string, params?: unknown[]): T[] => {
    const r = overrides?.allResult;
    return (typeof r === "function" ? r(sql, params) : (r ?? [])) as T[];
  };
  const getRow = (sql: string, params?: unknown[]): unknown => {
    const r = overrides?.getResult;
    return typeof r === "function" ? r(sql, params) : (r ?? null);
  };
  const exec = async (sql: string): Promise<void> => {
    calls.push({ method: "exec", sql });
    const error = overrides?.execError?.(sql);
    if (error) {
      throw error;
    }
  };

  let shared: TPgConnection | undefined;

  return {
    calls,
    releaseCount: () => released,
    destroyCount: () => destroyed,
    async run(sql: string, params?: unknown[]): Promise<TPgRunResult> {
      calls.push({ method: "run", sql, params });
      return { ...runResult, ...overrides?.runResponder?.(sql, params) };
    },
    async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
      calls.push({ method: "all", sql, params });
      return allRows<T>(sql, params);
    },
    async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
      calls.push({ method: "get", sql, params });
      return getRow(sql, params) as T | null;
    },
    exec,
    async getConnection(): Promise<TPgConnection> {
      if (overrides?.reuseConnection && shared) return shared;
      shared = {
        async run(sql: string, params?: unknown[]): Promise<TPgRunResult> {
          calls.push({ method: "run", sql, params });
          return { ...runResult, ...overrides?.runResponder?.(sql, params) };
        },
        async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
          calls.push({ method: "all", sql, params });
          return allRows<T>(sql, params);
        },
        async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
          calls.push({ method: "get", sql, params });
          return getRow(sql, params) as T | null;
        },
        exec,
        release: vi.fn(() => {
          released++;
        }),
        ...(overrides?.destroyable === false
          ? {}
          : {
              destroy: vi.fn(() => {
                destroyed++;
              }),
            }),
      };
      return shared;
    },
    async close(): Promise<void> {},
  };
}

/** The `DbError` a write rejects with (fails the test when it resolves or throws something else). */
export async function caught(p: Promise<unknown>): Promise<DbError> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DbError);
  return error as DbError;
}
