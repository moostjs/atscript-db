import { describe, it, expect, vi, afterEach } from "vite-plus/test";

import { SchemaSync, SyncEntry } from "../sync";
import type { TSyncResult } from "../sync";
import type { DbSpace } from "../table/db-space";

/**
 * Coverage for the `onError` reporting policy (a production consumer lost
 * months of index/FK failures to the silent NoopLogger default).
 * `reportOutcome` never touches the space, so a stub suffices — the
 * `planSchema` / `syncSchema` wrapper smoke tests live in
 * schema-sync.spec.ts where the full MockAdapter exists.
 */

const stubSpace = {} as DbSpace;

type TReportOutcome = {
  reportOutcome: (result: TSyncResult, onError: "throw" | "warn" | "silent") => void;
};

function makeResult(withError: boolean): TSyncResult {
  const entries = [
    new SyncEntry({ name: "users", status: "create" }),
    ...(withError
      ? [new SyncEntry({ name: "posts", status: "error", errors: ["index DDL failed"] })]
      : []),
  ];
  return { status: "synced", schemaHash: "abc", entries };
}

function makeLogger() {
  return { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

describe("SchemaSync.reportOutcome (onError policy)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('"warn" (default): emits a summary + per-entry errors via the logger', () => {
    const logger = makeLogger();
    const sync = new SchemaSync(stubSpace, logger) as unknown as TReportOutcome;

    sync.reportOutcome(makeResult(true), "warn");

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("1 create, 1 error"));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"posts" failed'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("index DDL failed"));
  });

  it("falls back to console when no logger is configured (NoopLogger default)", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const sync = new SchemaSync(stubSpace) as unknown as TReportOutcome;

    sync.reportOutcome(makeResult(true), "warn");

    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("[schema-sync]"));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("index DDL failed"));
  });

  it('"throw": reports, then throws with the error lines', () => {
    const logger = makeLogger();
    const sync = new SchemaSync(stubSpace, logger) as unknown as TReportOutcome;

    expect(() => sync.reportOutcome(makeResult(true), "throw")).toThrow(/1 entry failed/);
    expect(logger.error).toHaveBeenCalled();
  });

  it('"silent": legacy behavior — nothing emitted, nothing thrown', () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const sync = new SchemaSync(stubSpace) as unknown as TReportOutcome;

    sync.reportOutcome(makeResult(true), "silent");

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("no errors: summary only, no error lines, no throw", () => {
    const logger = makeLogger();
    const sync = new SchemaSync(stubSpace, logger) as unknown as TReportOutcome;

    sync.reportOutcome(makeResult(false), "throw");

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("1 create"));
    expect(logger.error).not.toHaveBeenCalled();
  });
});
