import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbError, DbSpace } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// A SERIALIZABLE conflict (`40001`) or a deadlock (`40P01`) can fail the
// COMMIT itself or a plain read inside the transaction; both reject with the
// retryable `DbError` (a caller's retry loop keys on `retryable`), not the
// raw driver error.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/constraint-errors.as");
});

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

function setup(overrides?: Parameters<typeof createMockDriver>[0]) {
  const driver = createMockDriver(overrides);
  const space = new DbSpace(() => new PostgresAdapter(driver));
  const table: any = space.getTable(fx.CeItem as never);
  return { driver, table, adapter: table.dbAdapter as PostgresAdapter };
}

const timeout = () => Object.assign(new Error("Query read timeout"), { code: "ETIMEDOUT" });

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe("[postgres] contention errors", () => {
  it.each([
    ["40001", "SERIALIZATION_FAILURE"],
    ["40P01", "DEADLOCK"],
    ["55P03", "LOCK_TIMEOUT"],
  ])("%s raised at COMMIT is the retryable %s", async (code, mapped) => {
    const raw = pgError(code);
    const { driver, adapter } = setup({
      execError: (sql) => (sql === "COMMIT" ? raw : undefined),
    });
    const error = await rejection(
      adapter.withTransaction(async () => {}, { isolation: "serializable" }),
    );
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe(mapped);
    expect((error as DbError).retryable).toBe(true);
    expect((error as DbError).cause).toBe(raw);
    expect(driver.releaseCount()).toBe(1);
    expect(driver.destroyCount()).toBe(0);
    // the failed COMMIT already ended the transaction: no ROLLBACK on the released connection
    expect(driver.calls.map((c) => c.sql)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "COMMIT",
    ]);
  });

  it("a non-contention COMMIT failure passes through unchanged", async () => {
    const boom = pgError("XX000");
    const { adapter } = setup({ execError: (sql) => (sql === "COMMIT" ? boom : undefined) });
    expect(await rejection(adapter.withTransaction(async () => {}))).toBe(boom);
  });

  it("40001 on a plain read inside the transaction is retryable", async () => {
    const { driver, table, adapter } = setup({
      getResult: () => {
        throw pgError("40001");
      },
    });
    const error = await rejection(
      adapter.withTransaction(() => table.count({ filter: {}, controls: {} }), {
        isolation: "serializable",
      }),
    );
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("SERIALIZATION_FAILURE");
    expect((error as DbError).retryable).toBe(true);
    expect(driver.calls.at(-1)!.sql).toBe("ROLLBACK");
  });

  it("40001 on a plain read outside a transaction is retryable", async () => {
    const { table } = setup({
      getResult: () => {
        throw pgError("40001");
      },
    });
    const error = await rejection(table.count({ filter: {}, controls: {} }));
    expect((error as DbError).code).toBe("SERIALIZATION_FAILURE");
  });

  it("a failed COMMIT does not poison the next transaction on the same connection object", async () => {
    let failCommit = true;
    const { driver, adapter } = setup({
      reuseConnection: true,
      execError: (sql) => {
        if (sql === "COMMIT" && failCommit) {
          failCommit = false;
          return pgError("40001");
        }
        return undefined;
      },
    });
    await rejection(adapter.withTransaction(async () => {}));
    // an ordinary failing transaction must still ROLLBACK and release
    const boom = new Error("boom");
    expect(
      await rejection(
        adapter.withTransaction(async () => {
          throw boom;
        }),
      ),
    ).toBe(boom);
    expect(driver.calls.map((c) => c.sql)).toEqual(["BEGIN", "COMMIT", "BEGIN", "ROLLBACK"]);
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
    expect(driver.calls.map((c) => c.sql)).toEqual(["BEGIN", "COMMIT", "BEGIN", "ROLLBACK"]);
    expect(driver.releaseCount()).toBe(2);
  });

  describe("a COMMIT that fails on the client (no server SQLSTATE)", () => {
    it("discards the connection and sends no ROLLBACK", async () => {
      const raw = timeout();
      const { driver, adapter } = setup({
        execError: (sql) => (sql === "COMMIT" ? raw : undefined),
      });
      expect(await rejection(adapter.withTransaction(async () => {}))).toBe(raw);
      expect(driver.destroyCount()).toBe(1);
      expect(driver.releaseCount()).toBe(0);
      expect(driver.calls.map((c) => c.sql)).toEqual(["BEGIN", "COMMIT"]);
    });

    it("a driver without destroy() gets a best-effort ROLLBACK, then release", async () => {
      const raw = timeout();
      const { driver, adapter } = setup({
        destroyable: false,
        execError: (sql) => (sql === "COMMIT" ? raw : undefined),
      });
      expect(await rejection(adapter.withTransaction(async () => {}))).toBe(raw);
      expect(driver.releaseCount()).toBe(1);
      expect(driver.calls.map((c) => c.sql)).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
    });
  });
});
