import { afterEach, describe, it, expect, vi } from "vite-plus/test";

import { PgDriver, parseTimestampUtc, sanitizeParams } from "../pg-driver";

/** The per-pool type parsers a `PgDriver` built from a config installs (no connection is opened). */
async function typeParser(oid: number): Promise<(val: string) => unknown> {
  const driver = new PgDriver({ connectionString: "postgresql://u@127.0.0.1:1/none" });
  const pool = (await (driver as any).getPool()) as { options: { types: any } };
  const parser = pool.options.types.getTypeParser(oid, "text");
  await driver.close();
  return parser;
}

const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;
const ZONES = ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Chatham", "Europe/London"];
const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe("[postgres] TIMESTAMP parsing (since 0.1.151: wall time read as UTC)", () => {
  it.each(ZONES)("a timestamp without time zone is the same instant under TZ=%s", async (tz) => {
    process.env.TZ = tz;
    const parse = await typeParser(TIMESTAMP_OID);
    expect(parse("2024-01-01 12:00:00")).toBe(Date.UTC(2024, 0, 1, 12, 0, 0));
    expect(parse("2024-07-15 23:59:59.123456")).toBe(Date.UTC(2024, 6, 15, 23, 59, 59, 123));
    expect(parse("2024-03-10 02:30:00.5")).toBe(Date.UTC(2024, 2, 10, 2, 30, 0, 500));
  });

  it.each(ZONES)("TIMESTAMPTZ keeps parsing by its own offset under TZ=%s", async (tz) => {
    process.env.TZ = tz;
    const parse = await typeParser(TIMESTAMPTZ_OID);
    expect(parse("2024-01-01 12:00:00+00")).toBe(Date.UTC(2024, 0, 1, 12));
    expect(parse("2024-01-01 12:00:00.123+05:30")).toBe(Date.UTC(2024, 0, 1, 6, 30, 0, 123));
  });

  it("keeps two-digit and five-digit years literal; non-finite / BC values stay strings", () => {
    const y44 = new Date(0);
    y44.setUTCFullYear(44, 2, 15);
    y44.setUTCHours(12, 0, 0, 0);
    expect(parseTimestampUtc("0044-03-15 12:00:00")).toBe(y44.getTime());
    expect(parseTimestampUtc("10000-01-01 00:00:00")).toBe(253402300800000);
    expect(parseTimestampUtc("infinity")).toBe("infinity");
    expect(parseTimestampUtc("-infinity")).toBe("-infinity");
    expect(parseTimestampUtc("0044-03-15 12:00:00 BC")).toBe("0044-03-15 12:00:00 BC");
  });
});

describe("[postgres] sanitizeParams", () => {
  it("binds the caller's array as is when it holds no undefined", () => {
    const params = [1, "a", null, true];
    expect(sanitizeParams(params)).toBe(params);
  });

  it("copies, turning undefined (and holes) into null, without touching the input", () => {
    const params = [1, undefined, "a"];
    const out = sanitizeParams(params);
    expect(out).toEqual([1, null, "a"]);
    expect(params).toEqual([1, undefined, "a"]);
    // oxlint-disable-next-line no-sparse-arrays
    expect(sanitizeParams([1, , 3])).toEqual([1, null, 3]);
  });

  it("no params: an empty bind array", () => {
    expect(sanitizeParams(undefined)).toEqual([]);
  });
});

describe("[postgres] idle pool client errors (since 0.1.154)", () => {
  type TPool = import("pg").Pool;
  const idleError = () =>
    Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
    });

  it("an owned pool logs an idle client's error instead of throwing", async () => {
    const warn = vi.fn();
    const driver = new PgDriver("postgresql://u@127.0.0.1:1/none", { logger: { warn } });
    const pool = (await (driver as any).getPool()) as TPool;
    expect(pool.listenerCount("error")).toBe(1);
    expect(() => pool.emit("error", idleError(), {} as never)).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("57P01");
    expect(warn.mock.calls[0][0]).toContain("terminating connection");
    await driver.close();
  });

  it("defaults to console.warn (pool config form too)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const driver = new PgDriver({ connectionString: "postgresql://u@127.0.0.1:1/none" });
      const pool = (await (driver as any).getPool()) as TPool;
      pool.emit("error", idleError(), {} as never);
      expect(warn).toHaveBeenCalledOnce();
      await driver.close();
    } finally {
      warn.mockRestore();
    }
  });

  it("a checked-out client's connection error is logged, and release() discards the client", async () => {
    const { EventEmitter } = await import("node:events");
    const client = Object.assign(new EventEmitter(), { release: vi.fn(), query: vi.fn() });
    const pool = { query: vi.fn(), connect: async () => client, end: async () => {} };
    const warn = vi.fn();
    const driver = new PgDriver(pool as never, { logger: { warn } });
    const conn = await driver.getConnection();
    expect(client.listenerCount("error")).toBe(1);
    const err = idleError();
    expect(() => client.emit("error", err)).not.toThrow();
    // pg follows the server's error with "Connection terminated unexpectedly"
    client.emit("error", new Error("Connection terminated unexpectedly"));
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("57P01");
    conn.release();
    expect(client.listenerCount("error")).toBe(0);
    expect(client.release).toHaveBeenCalledWith(err);
  });

  it("a healthy checked-out client is released normally", async () => {
    const { EventEmitter } = await import("node:events");
    const client = Object.assign(new EventEmitter(), { release: vi.fn(), query: vi.fn() });
    const pool = { query: vi.fn(), connect: async () => client, end: async () => {} };
    const conn = await new PgDriver(pool as never).getConnection();
    conn.release();
    expect(client.listenerCount("error")).toBe(0);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("leaves a caller's pre-created pool alone", async () => {
    const { Pool } = (await import("pg")).default;
    const pool = new Pool({ connectionString: "postgresql://u@127.0.0.1:1/none" });
    const driver = new PgDriver(pool);
    expect(pool.listenerCount("error")).toBe(0);
    await driver.close();
  });
});
