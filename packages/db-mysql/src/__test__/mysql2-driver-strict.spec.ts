import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

/**
 * `Mysql2Driver` strict mode (since 0.1.148): every connection the pool opens
 * gets `STRICT_TRANS_TABLES` appended to its session `sql_mode`; `strictMode:
 * false` opts out. Mock `mysql2/promise` — the live counterpart is
 * `mysql2-driver-strict.live.spec.ts`.
 */

const listeners: Array<(conn: unknown) => void> = [];
const createPool = vi.fn((_opts: unknown) => ({
  on: (event: string, cb: (conn: unknown) => void) => {
    if (event === "connection") listeners.push(cb);
  },
  end: async () => {},
}));
vi.mock("mysql2/promise", () => ({ default: { createPool }, createPool }));

import { Mysql2Driver, ENSURE_STRICT_SQL } from "../mysql2-driver";

const open = () => {
  const queries: string[] = [];
  for (const cb of listeners)
    cb({ query: (sql: string, done: () => void) => (queries.push(sql), done()) });
  return queries;
};

beforeEach(() => {
  listeners.length = 0;
  createPool.mockClear();
});

describe("Mysql2Driver strictMode", () => {
  it("runs the sql_mode SET on every new connection (URI form)", async () => {
    const driver = new Mysql2Driver("mysql://u@h/db");
    await driver.close();
    expect(open()).toEqual([ENSURE_STRICT_SQL]);
    expect(ENSURE_STRICT_SQL).toContain("STRICT_TRANS_TABLES");
    // appends to the server's modes instead of replacing them
    expect(ENSURE_STRICT_SQL).toContain("@@SESSION.sql_mode");
  });

  it("covers pool-options and pre-created pools too", async () => {
    await new Mysql2Driver({ host: "h" }).close();
    expect(open()).toEqual([ENSURE_STRICT_SQL]);
    listeners.length = 0;
    const pool = { execute() {}, on: (_e: string, cb: (c: unknown) => void) => listeners.push(cb) };
    new Mysql2Driver(pool as never);
    expect(open()).toEqual([ENSURE_STRICT_SQL]);
  });

  it("strictMode: false installs nothing", async () => {
    await new Mysql2Driver("mysql://u@h/db", { strictMode: false }).close();
    expect(listeners).toHaveLength(0);
    await new Mysql2Driver({ host: "h" }, { strictMode: false }).close();
    expect(listeners).toHaveLength(0);
  });
});
