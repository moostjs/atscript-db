import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { AtscriptDbTable, DbError } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

/** Locking reads + transaction isolation on MySQL (since 0.1.162). */

let VersionedItemTable: any;

beforeAll(async () => {
  await prepareFixtures();
  VersionedItemTable = (await import("./fixtures/version-occ.as")).VersionedItemTable;
});

describe("MysqlAdapter — locking reads", () => {
  let driver: ReturnType<typeof createMockDriver>;
  let adapter: MysqlAdapter;
  let table: AtscriptDbTable;

  beforeEach(() => {
    driver = createMockDriver();
    adapter = new MysqlAdapter(driver);
    table = new AtscriptDbTable(VersionedItemTable, adapter);
  });

  const connSql = () => driver.calls.filter((c) => c.via === "conn").map((c) => c.sql);

  it("renders FOR UPDATE / FOR SHARE [NOWAIT | SKIP LOCKED] on the transaction's connection", async () => {
    await adapter.withTransaction(async () => {
      await table.findOne({ filter: { id: 1 }, controls: {} }, { lock: "update" });
      await table.findMany(
        { filter: {}, controls: { $sort: { id: 1 } } },
        { lock: "share", wait: "skipLocked" },
      );
      await table.findById(1, { lock: "update", wait: "nowait" });
    });
    const selects = connSql().filter((s) => s.startsWith("SELECT"));
    expect(selects[0]).toMatch(/ LIMIT \? FOR UPDATE$/);
    expect(selects[1]).toMatch(/ ORDER BY `id` ASC FOR SHARE SKIP LOCKED$/);
    expect(selects[2]).toMatch(/ LIMIT \? FOR UPDATE NOWAIT$/);
  });

  it("a plain read has no locking clause", async () => {
    await table.findOne({ filter: { id: 1 }, controls: {} });
    expect(driver.calls.find((c) => c.sql.startsWith("SELECT"))!.sql).not.toMatch(/FOR /);
  });

  it("maps ER_LOCK_NOWAIT (3572) / ER_LOCK_WAIT_TIMEOUT (1205) on a read to a retryable LOCK_TIMEOUT", async () => {
    for (const errno of [3572, 1205, 1213]) {
      const failing = createMockDriver();
      const getConnection = failing.getConnection.bind(failing);
      failing.getConnection = async () => {
        const conn = await getConnection();
        conn.get = async () => {
          throw Object.assign(new Error("locked"), { errno });
        };
        return conn;
      };
      const t = new AtscriptDbTable(VersionedItemTable, new MysqlAdapter(failing));
      const error = await t.dbAdapter
        .withTransaction(() =>
          t.findOne({ filter: { id: 1 }, controls: {} }, { lock: "update", wait: "nowait" }),
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DbError);
      expect(error).toMatchObject({
        code: errno === 1213 ? "DEADLOCK" : "LOCK_TIMEOUT",
        retryable: true,
      });
    }
  });
});

describe("MysqlAdapter — withTransaction isolation", () => {
  it("SET TRANSACTION ISOLATION LEVEL … runs on the connection right before START TRANSACTION", async () => {
    const driver = createMockDriver();
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(VersionedItemTable, adapter);
    await adapter.withTransaction(async () => {}, { isolation: "read committed" });
    await adapter.withTransaction(async () => {});
    expect(driver.calls.filter((c) => c.via === "conn").map((c) => c.sql)).toEqual([
      "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
      "START TRANSACTION",
      "COMMIT",
      "START TRANSACTION",
      "COMMIT",
    ]);
  });

  it("releases the connection when the isolation statement fails", async () => {
    const driver = createMockDriver({
      execError: (sql) => (sql.startsWith("SET TRANSACTION") ? new Error("boom") : undefined),
    });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(VersionedItemTable, adapter);
    await expect(
      adapter.withTransaction(async () => {}, { isolation: "serializable" }),
    ).rejects.toThrow("boom");
    expect(driver.releaseCount()).toBe(1);
  });

  it("destroys (never releases) the connection when START TRANSACTION fails after SET TRANSACTION", async () => {
    let destroyed = 0;
    const driver = createMockDriver({
      execError: (sql) => (sql === "START TRANSACTION" ? new Error("gone") : undefined),
    });
    const getConnection = driver.getConnection.bind(driver);
    driver.getConnection = async () => ({
      ...(await getConnection()),
      destroy: () => void destroyed++,
    });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(VersionedItemTable, adapter);
    await expect(
      adapter.withTransaction(async () => {}, { isolation: "serializable" }),
    ).rejects.toThrow("gone");
    expect(destroyed).toBe(1);
    expect(driver.releaseCount()).toBe(0);
    // no pending level → a plain failed START TRANSACTION still releases
    await expect(adapter.withTransaction(async () => {})).rejects.toThrow("gone");
    expect(destroyed).toBe(1);
    expect(driver.releaseCount()).toBe(1);
  });
});
