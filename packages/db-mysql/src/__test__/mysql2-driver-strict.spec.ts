import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

/**
 * `Mysql2Driver` strict mode (since 0.1.148): every connection the pool opens
 * gets `STRICT_TRANS_TABLES` appended to its session `sql_mode`; `strictMode:
 * false` opts out. Mock `mysql2/promise` — the live counterpart is
 * `mysql2-driver-strict.live.spec.ts`.
 */

const listeners: Array<(conn: unknown) => void> = [];
const acquireListeners: Array<(conn: unknown) => void> = [];
const createPool = vi.fn((_opts: unknown) => ({
  on: (event: string, cb: (conn: unknown) => void) => {
    if (event === "connection") listeners.push(cb);
    if (event === "acquire") acquireListeners.push(cb);
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
  acquireListeners.length = 0;
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
    const pool = {
      execute() {},
      on: (e: string, cb: (c: unknown) => void) => e === "connection" && listeners.push(cb),
    };
    new Mysql2Driver(pool as never);
    expect(open()).toEqual([ENSURE_STRICT_SQL]);
  });

  it("a connection opened before the driver is made strict once, on its first acquire", () => {
    const pool = {
      execute() {},
      on: (e: string, cb: (c: unknown) => void) =>
        (e === "acquire" ? acquireListeners : listeners).push(cb),
    };
    new Mysql2Driver(pool as never);
    const queries: string[] = [];
    const warmed = { query: (sql: string, done: () => void) => (queries.push(sql), done()) };
    for (let i = 0; i < 3; i++) for (const cb of acquireListeners) cb(warmed);
    expect(queries).toEqual([ENSURE_STRICT_SQL]);
    // a connection the pool opens later is handled by `connection`, and not re-queued on acquire
    const fresh = { query: (sql: string, done: () => void) => (queries.push(sql), done()) };
    for (const cb of listeners) cb(fresh);
    for (const cb of acquireListeners) cb(fresh);
    expect(queries).toEqual([ENSURE_STRICT_SQL, ENSURE_STRICT_SQL]);
  });

  it("strictMode: false installs nothing", async () => {
    await new Mysql2Driver("mysql://u@h/db", { strictMode: false }).close();
    expect(listeners).toHaveLength(0);
    await new Mysql2Driver({ host: "h" }, { strictMode: false }).close();
    expect(listeners).toHaveLength(0);
    expect(acquireListeners).toHaveLength(0);
  });
});

describe("Mysql2Driver JSON columns", () => {
  // Since 0.1.155: JSON is read as text, like MariaDB's LONGTEXT JSON and
  // SQLite — the mapper parses it, so a JSON string value stays a string.
  it("reads JSON columns as text (URI and pool-options forms)", async () => {
    await new Mysql2Driver("mysql://u@h/db").close();
    await new Mysql2Driver({ host: "h", jsonStrings: false }).close();
    expect(createPool.mock.calls.map(([opts]) => (opts as any).jsonStrings)).toEqual([true, true]);
  });

  it("the typeCast reads JSON as UTF-8 text whatever the pool's jsonStrings", async () => {
    await new Mysql2Driver("mysql://u@h/db").close();
    const typeCast = (createPool.mock.calls.at(-1)![0] as any).typeCast;
    const field = { type: "JSON", string: (enc?: string) => (enc === "utf8" ? '"abc"' : "?") };
    expect(typeCast(field, () => "parsed")).toBe('"abc"');
    expect(typeCast({ type: "VAR_STRING" }, () => "next")).toBe("next");
  });
});
