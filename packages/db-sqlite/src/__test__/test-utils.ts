import path from "path";

import { prepareFixtures as prepare } from "@atscript/typescript/test-utils";
import dbPlugin from "@atscript/db/plugin";

import type { BetterSqlite3Driver } from "../better-sqlite3-driver";
import type { TSqliteDriver, TSqliteRunResult } from "../types";

export async function prepareFixtures() {
  const fixturesDir = path.join(path.dirname(import.meta.url.slice(7)), "fixtures");
  await prepare({
    rootDir: fixturesDir,
    plugins: [dbPlugin()],
  });
}

// ── Gate / transaction test helpers ──────────────────────────────────────

/** A pass-through driver that records every `exec` (BEGIN/COMMIT/DDL/PRAGMA). Subclass per spec. */
export class RecordingDriver implements TSqliteDriver {
  readonly execs: string[] = [];
  /** Every `run` / `all` / `get` statement, in order — clear with `statements.length = 0`. */
  readonly statements: string[] = [];
  constructor(protected readonly inner: BetterSqlite3Driver) {}
  run(sql: string, params?: unknown[]): TSqliteRunResult {
    this.statements.push(sql);
    return this.inner.run(sql, params);
  }
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    this.statements.push(sql);
    return this.inner.all<T>(sql, params);
  }
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    this.statements.push(sql);
    return this.inner.get<T>(sql, params);
  }
  exec(sql: string): void {
    this.execs.push(sql);
    this.inner.exec(sql);
  }
  close(): void {
    this.inner.close();
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Resolves "pending" when `p` has not settled within `ms`, else "settled". */
export async function settledWithin(
  p: Promise<unknown>,
  ms: number,
): Promise<"pending" | "settled"> {
  const timer = new Promise<"pending" | "settled">((r) => setTimeout(() => r("pending"), ms));
  return Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    timer,
  ]);
}
