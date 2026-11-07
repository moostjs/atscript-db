import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbError, DbSpace } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// A deadlock (1213) or lock wait timeout (1205) can fail the COMMIT itself or
// a plain read inside the transaction; both reject with the retryable
// `DbError` (a caller's retry loop keys on `retryable`), not the raw driver
// error.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/constraint-errors.as");
});

const mysqlError = (errno: number) =>
  Object.assign(new Error(`mysql ${errno}`), { errno, sqlMessage: `mysql ${errno}` });

function setup(overrides?: Parameters<typeof createMockDriver>[0] & { readError?: Error }) {
  const driver = createMockDriver(overrides);
  const { readError } = overrides ?? {};
  if (readError) {
    // every read statement (pool or dedicated connection) fails
    const failGet = async () => {
      throw readError;
    };
    driver.get = failGet as never;
    const getConnection = driver.getConnection.bind(driver);
    driver.getConnection = async () => ({ ...(await getConnection()), get: failGet as never });
  }
  const space = new DbSpace(() => new MysqlAdapter(driver));
  const table: any = space.getTable(fx.CeItem as never);
  return { driver, table, adapter: table.dbAdapter as MysqlAdapter };
}

const timeout = () =>
  Object.assign(new Error("Query inactivity timeout"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" });

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe("[mysql] contention errors", () => {
  it.each([
    [1213, "DEADLOCK"],
    [1205, "LOCK_TIMEOUT"],
    [3572, "LOCK_TIMEOUT"],
  ])("errno %i raised at COMMIT is the retryable %s", async (errno, mapped) => {
    const raw = mysqlError(errno);
    const { driver, adapter } = setup({
      execError: (sql) => (sql === "COMMIT" ? raw : undefined),
    });
    const error = await rejection(adapter.withTransaction(async () => {}));
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe(mapped);
    expect((error as DbError).retryable).toBe(true);
    expect((error as DbError).cause).toBe(raw);
    // the failed COMMIT already ended the transaction: no ROLLBACK, one release
    expect(driver.calls.map((c) => c.sql)).toEqual(["START TRANSACTION", "COMMIT"]);
    expect(driver.releaseCount()).toBe(1);
    expect(driver.destroyCount()).toBe(0);
  });

  it("a non-contention COMMIT failure passes through unchanged", async () => {
    const boom = mysqlError(1105);
    const { adapter } = setup({ execError: (sql) => (sql === "COMMIT" ? boom : undefined) });
    expect(await rejection(adapter.withTransaction(async () => {}))).toBe(boom);
  });

  it("1213 on a plain read inside the transaction is retryable", async () => {
    const { driver, table, adapter } = setup({ readError: mysqlError(1213) });
    const error = await rejection(
      adapter.withTransaction(() => table.count({ filter: {}, controls: {} })),
    );
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("DEADLOCK");
    expect((error as DbError).retryable).toBe(true);
    expect(driver.releaseCount()).toBe(1);
  });

  it("1205 on a plain read outside a transaction is retryable", async () => {
    const { table } = setup({ readError: mysqlError(1205) });
    const error = await rejection(table.count({ filter: {}, controls: {} }));
    expect((error as DbError).code).toBe("LOCK_TIMEOUT");
  });

  it("a failed COMMIT does not poison the next transaction on the same connection object", async () => {
    let failCommit = true;
    const { driver, adapter } = setup({
      reuseConnection: true,
      execError: (sql) => {
        if (sql === "COMMIT" && failCommit) {
          failCommit = false;
          return mysqlError(1213);
        }
        return undefined;
      },
    });
    await rejection(adapter.withTransaction(async () => {}));
    const boom = new Error("boom");
    expect(
      await rejection(
        adapter.withTransaction(async () => {
          throw boom;
        }),
      ),
    ).toBe(boom);
    expect(driver.calls.map((c) => c.sql)).toEqual([
      "START TRANSACTION",
      "COMMIT",
      "START TRANSACTION",
      "ROLLBACK",
    ]);
    expect(driver.releaseCount()).toBe(2);
  });

  it("a successful COMMIT leaves no mark: a later failed transaction on the same connection rolls back and releases", async () => {
    const { driver, adapter } = setup({ reuseConnection: true });
    await adapter.withTransaction(async () => {});
    const boom = new Error("boom");
    await rejection(
      adapter.withTransaction(async () => {
        throw boom;
      }),
    );
    expect(driver.calls.map((c) => c.sql)).toEqual([
      "START TRANSACTION",
      "COMMIT",
      "START TRANSACTION",
      "ROLLBACK",
    ]);
    expect(driver.releaseCount()).toBe(2);
  });

  describe("a COMMIT that fails on the client (no server errno)", () => {
    it("discards the connection and sends no ROLLBACK", async () => {
      const raw = timeout();
      const { driver, adapter } = setup({
        execError: (sql) => (sql === "COMMIT" ? raw : undefined),
      });
      expect(await rejection(adapter.withTransaction(async () => {}))).toBe(raw);
      expect(driver.destroyCount()).toBe(1);
      expect(driver.releaseCount()).toBe(0);
      expect(driver.calls.map((c) => c.sql)).toEqual(["START TRANSACTION", "COMMIT"]);
    });

    it("a driver without destroy() gets a best-effort ROLLBACK, then release", async () => {
      const raw = timeout();
      const { driver, adapter } = setup({
        destroyable: false,
        execError: (sql) => (sql === "COMMIT" ? raw : undefined),
      });
      expect(await rejection(adapter.withTransaction(async () => {}))).toBe(raw);
      expect(driver.releaseCount()).toBe(1);
      expect(driver.calls.map((c) => c.sql)).toEqual(["START TRANSACTION", "COMMIT", "ROLLBACK"]);
    });
  });
});
