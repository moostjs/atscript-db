import path from "path";

import { vi } from "vite-plus/test";
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
  allResult?: unknown[];
  getResult?: unknown;
}): TPgDriver & { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];

  const runResult: TPgRunResult = {
    affectedRows: 1,
    rows: [],
    ...overrides?.runResult,
  };

  return {
    calls,
    async run(sql: string, params?: unknown[]): Promise<TPgRunResult> {
      calls.push({ method: "run", sql, params });
      return runResult;
    },
    async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
      calls.push({ method: "all", sql, params });
      return (overrides?.allResult ?? []) as T[];
    },
    async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
      calls.push({ method: "get", sql, params });
      return (overrides?.getResult ?? null) as T | null;
    },
    async exec(sql: string): Promise<void> {
      calls.push({ method: "exec", sql });
    },
    async getConnection(): Promise<TPgConnection> {
      return {
        async run(sql: string, params?: unknown[]): Promise<TPgRunResult> {
          calls.push({ method: "run", sql, params });
          return runResult;
        },
        async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
          calls.push({ method: "all", sql, params });
          return (overrides?.allResult ?? []) as T[];
        },
        async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
          calls.push({ method: "get", sql, params });
          return (overrides?.getResult ?? null) as T | null;
        },
        async exec(sql: string): Promise<void> {
          calls.push({ method: "exec", sql });
        },
        release: vi.fn(),
      };
    },
    async close(): Promise<void> {},
  };
}
