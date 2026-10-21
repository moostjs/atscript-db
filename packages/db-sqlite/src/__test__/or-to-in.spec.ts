import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.165 an `$or` of one field's equalities renders as `IN (…)`, so a
// per-row key filter over a large batch no longer fails with SQLite's
// "Expression tree is too large (maximum depth 1000)".

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/with-controls.as");
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  for (const type of [fx.WsTicket, fx.WsIssue]) await space.getTable(type).ensureTable();
});

afterAll(() => {
  driver.close();
});

describe("[sqlite] large $or of key equalities", () => {
  it("1500 { id } branches read, count and delete", async () => {
    const issues: any = space.getTable(fx.WsIssue);
    const rows = Array.from({ length: 1500 }, (_, i) => ({
      id: i + 1,
      title: `t${i}`,
      severity: 1,
    }));
    await issues.insertMany(rows);
    const filter = { $or: rows.map((r) => ({ id: r.id })) };
    expect(await issues.count({ filter })).toBe(1500);
    expect((await issues.deleteMany(filter)).deletedCount).toBe(1500);
  });
});
