import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";

import { PgDriver } from "../pg-driver";
import { pgAdmin, pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise (CI has no server). Override with `ATSCRIPT_PG_TEST_URL` (or
// `POSTGRES_TEST_URI`; an admin connection — the spec creates and drops its
// own database). A backend terminated while its pool client is idle or
// checked out is logged, not thrown out of an EventEmitter (since 0.1.154):
// the process survives and the next query opens a fresh connection.

const DB = "r15_poolerr_pg";

const reachable = await pgReachable();

/** Resolves once `fn` has been called, failing after `ms`. */
async function calledWithin(fn: ReturnType<typeof vi.fn>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (fn.mock.calls.length === 0) {
    if (Date.now() > until) throw new Error("the logger was never called");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const PID_SQL = "SELECT pg_backend_pid() AS pid";

describe.skipIf(!reachable)("[postgres live] broken pool connections", () => {
  let driver: PgDriver;
  const warn = vi.fn();

  beforeAll(async () => {
    driver = new PgDriver(
      { connectionString: await recreatePgDatabase(DB, { force: true }), max: 2 },
      { logger: { warn } },
    );
  });

  afterAll(async () => {
    await driver?.close();
    await dropPgDatabase(DB, { force: true });
  });

  it("an idle client's terminated backend is logged; the next query reconnects", async () => {
    warn.mockClear();
    const before = await driver.get<{ pid: number }>(PID_SQL);
    // the client is idle in the pool now
    expect(await pgAdmin("SELECT pg_terminate_backend($1)", { params: [before!.pid] })).toBe(true);
    await calledWithin(warn);
    expect(warn.mock.calls[0][0]).toContain("idle pool connection lost");
    const after = await driver.get<{ pid: number }>(PID_SQL);
    expect(after!.pid).not.toBe(before!.pid);
  });

  it("a checked-out client's terminated backend is logged; its statements reject", async () => {
    warn.mockClear();
    const conn = await driver.getConnection();
    const { pid } = (await conn.get<{ pid: number }>(PID_SQL))!;
    // checked out, between two statements (e.g. inside a transaction)
    expect(await pgAdmin("SELECT pg_terminate_backend($1)", { params: [pid] })).toBe(true);
    await calledWithin(warn);
    expect(warn.mock.calls[0][0]).toContain("checked-out pool connection lost");
    await expect(conn.get(PID_SQL)).rejects.toThrow();
    conn.release();
    const after = await driver.get<{ pid: number }>(PID_SQL);
    expect(after!.pid).not.toBe(pid);
  });
});
