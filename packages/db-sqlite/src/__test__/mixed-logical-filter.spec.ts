import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

/**
 * Finding 34 on a real engine: a filter node mixing comparison fields with a
 * logical operator (`{ id, nextRefreshAt: { $lte }, $or: [...] }`) — what a
 * `transformFilter` overlay produces when it spreads a scope predicate next to
 * a URL-produced group — must AND every sibling. Pinned through affected-row
 * isolation on findMany / count / updateMany / deleteMany.
 */

type Row = Record<string, any>;
let Job: any;

const MIXED = { id: 101, nextRefreshAt: { $lte: 5 }, $or: [{ a: 1 }, { b: 2 }] } as any;

describe("SQLite — mixed comparison + logical filter nodes", () => {
  let driver: BetterSqlite3Driver;
  let table: AtscriptDbTable<any, Row, any, any, any, any, any>;

  beforeAll(async () => {
    await prepareFixtures();
    ({ Job } = await import("./fixtures/guard-fixtures.as"));
  });

  beforeEach(async () => {
    driver = new BetterSqlite3Driver(":memory:");
    table = new AtscriptDbTable(Job, new SqliteAdapter(driver));
    await table.ensureTable();
    await table.insertMany([
      { id: 101, nextRefreshAt: 3, a: 1, b: 0, state: "match" }, // every predicate holds
      { id: 102, nextRefreshAt: 3, a: 1, b: 0, state: "other-id" }, // id sibling fails
      { id: 103, nextRefreshAt: 9, a: 1, b: 0, state: "other-time" }, // range sibling fails
      { id: 104, nextRefreshAt: 3, a: 0, b: 0, state: "other-or" }, // $or fails
    ]);
  });

  afterEach(() => {
    driver.close();
  });

  it("findMany returns only the row satisfying every sibling and the $or", async () => {
    const rows = await table.findMany({ filter: MIXED });
    expect(rows.map((r) => r.id)).toEqual([101]);
  });

  it("count agrees", async () => {
    expect(await table.count({ filter: MIXED })).toBe(1);
  });

  it("updateMany touches exactly the matching row", async () => {
    const res = await table.updateMany(MIXED, { flag: true } as any);
    expect(res.matchedCount).toBe(1);
    const rows = await table.findMany({ filter: {}, controls: { $sort: { id: 1 } } } as any);
    expect(rows.map((r) => [r.id, r.flag])).toEqual([
      [101, true],
      [102, false],
      [103, false],
      [104, false],
    ]);
  });

  it("deleteMany removes exactly the matching row", async () => {
    const res = await table.deleteMany(MIXED);
    expect(res.deletedCount).toBe(1);
    const rows = await table.findMany({ filter: {}, controls: { $sort: { id: 1 } } } as any);
    expect(rows.map((r) => r.id)).toEqual([102, 103, 104]);
  });
});
