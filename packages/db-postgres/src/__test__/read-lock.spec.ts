import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable, DbError } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

/** Locking reads + transaction isolation on PostgreSQL (since 0.1.162). */

let VersionedItemTable: any;

beforeAll(async () => {
  await prepareFixtures();
  VersionedItemTable = (await import("./fixtures/version-occ.as")).VersionedItemTable;
});

function setup(getResult?: (sql: string) => unknown) {
  const driver = createMockDriver({ getResult });
  const adapter = new PostgresAdapter(driver);
  const table = new AtscriptDbTable(VersionedItemTable, adapter);
  return { driver, adapter, table };
}

describe("PostgresAdapter — locking reads", () => {
  it("renders FOR UPDATE / FOR SHARE [NOWAIT | SKIP LOCKED] after LIMIT", async () => {
    const { driver, adapter, table } = setup();
    await adapter.withTransaction(async () => {
      await table.findOne({ filter: { id: 1 }, controls: {} }, { lock: "update" });
      await table.findMany(
        { filter: {}, controls: { $sort: { id: 1 }, $limit: 5 } },
        { lock: "share", wait: "skipLocked" },
      );
      await table.findById(1, { lock: "update", wait: "nowait" });
    });
    const selects = driver.calls.map((c) => c.sql).filter((s) => s.startsWith("SELECT"));
    expect(selects[0]).toMatch(/ LIMIT \$\d+ FOR UPDATE$/);
    expect(selects[1]).toMatch(/ LIMIT \$\d+ FOR SHARE SKIP LOCKED$/);
    expect(selects[2]).toMatch(/ LIMIT \$\d+ FOR UPDATE NOWAIT$/);
  });

  it("maps 55P03 (NOWAIT) / 40001 / 40P01 on a read to retryable DbErrors", async () => {
    const cases: Array<[string, string]> = [
      ["55P03", "LOCK_TIMEOUT"],
      ["40001", "SERIALIZATION_FAILURE"],
      ["40P01", "DEADLOCK"],
    ];
    for (const [sqlState, code] of cases) {
      const { adapter, table } = setup(() => {
        throw Object.assign(new Error("contention"), { code: sqlState });
      });
      const error = await adapter
        .withTransaction(() =>
          table.findOne({ filter: { id: 1 }, controls: {} }, { lock: "update", wait: "nowait" }),
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DbError);
      expect(error).toMatchObject({ code, retryable: true });
    }
  });
});

describe("PostgresAdapter — withTransaction isolation", () => {
  it("opens the transaction with BEGIN ISOLATION LEVEL …", async () => {
    const { driver, adapter } = setup();
    await adapter.withTransaction(async () => {}, { isolation: "repeatable read" });
    await adapter.withTransaction(async () => {}, { isolation: "serializable" });
    await adapter.withTransaction(async () => {});
    expect(driver.calls.map((c) => c.sql)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ",
      "COMMIT",
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "COMMIT",
      "BEGIN",
      "COMMIT",
    ]);
  });
});
