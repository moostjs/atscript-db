import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures, RecordingDriver } from "./test-utils";

/**
 * Locking reads + isolation on SQLite (since 0.1.162): every transaction is
 * `BEGIN IMMEDIATE` (the database write lock), so a lock is accepted as a
 * no-op and every isolation level is satisfied.
 */

let VersionedUserTable: any;

beforeAll(async () => {
  await prepareFixtures();
  VersionedUserTable = (await import("./fixtures/version-occ.as")).VersionedUserTable;
});

describe("SqliteAdapter — locking reads and isolation", () => {
  let driver: RecordingDriver;
  let adapter: SqliteAdapter;
  let users: AtscriptDbTable;

  beforeEach(async () => {
    driver = new RecordingDriver(new BetterSqlite3Driver(":memory:"));
    adapter = new SqliteAdapter(driver);
    users = new AtscriptDbTable(VersionedUserTable, adapter);
    await users.ensureTable();
    await users.insertOne({ id: 1, name: "a", status: "new", counter: 0 } as any);
    driver.execs.length = 0;
    driver.statements.length = 0;
  });

  it("accepts a lock inside a transaction as a no-op (no locking clause; BEGIN IMMEDIATE)", async () => {
    const row = await adapter.withTransaction(() =>
      users.findOne({ filter: { id: 1 }, controls: {} }, { lock: "update", wait: "nowait" }),
    );
    expect(row).toMatchObject({ id: 1, name: "a" });
    const rows = await adapter.withTransaction(() =>
      users.findMany({ filter: {}, controls: {} }, { lock: "share", wait: "skipLocked" }),
    );
    expect(rows).toHaveLength(1);
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "COMMIT", "BEGIN IMMEDIATE", "COMMIT"]);
    expect(driver.statements.some((s) => / FOR (UPDATE|SHARE)/.test(s))).toBe(false);
  });

  it("still requires a transaction", async () => {
    await expect(
      users.findOne({ filter: { id: 1 }, controls: {} }, { lock: "update" }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("every isolation level is satisfied (serializable), nested requests included", async () => {
    for (const isolation of ["read committed", "repeatable read", "serializable"] as const) {
      await adapter.withTransaction(
        () => adapter.withTransaction(async () => {}, { isolation: "serializable" }),
        { isolation },
      );
    }
    await adapter.withTransaction(() =>
      adapter.withTransaction(async () => {}, { isolation: "serializable" }),
    );
    expect(driver.execs.filter((s) => s.startsWith("BEGIN"))).toEqual(
      Array.from({ length: 4 }, () => "BEGIN IMMEDIATE"),
    );
  });

  it("a locking read and bounded updateMany / deleteMany share one transaction", async () => {
    await users.insertMany([
      { id: 2, name: "b", status: "new", counter: 0 },
      { id: 3, name: "c", status: "new", counter: 0 },
    ] as any[]);
    await adapter.withTransaction(async () => {
      const locked = await users.findMany(
        { filter: {}, controls: { $sort: { id: 1 }, $limit: 2 } },
        { lock: "update" },
      );
      expect(locked.map((r: any) => r.id)).toEqual([1, 2]);
      expect(
        await users.updateMany({}, { status: "seen" } as any, { limit: 2, sort: { id: -1 } }),
      ).toMatchObject({ matchedCount: 2, modifiedCount: 2 });
      expect(await users.deleteMany({}, { limit: 1 })).toEqual({ deletedCount: 1 });
    });
    const rows = await users.findMany({ filter: {}, controls: { $sort: { id: 1 } } });
    expect(rows.map((r: any) => [r.id, r.status])).toEqual([
      [2, "seen"],
      [3, "seen"],
    ]);
  });
});
