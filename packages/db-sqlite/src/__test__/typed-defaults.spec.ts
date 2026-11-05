import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// `@db.default 0` / `true` / `"active"` / `10.50` render the same DDL
// DEFAULT as the string spelling (`@db.default "0"` …), and the engine
// applies them to a row written outside atscript-db.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/typed-defaults.as");
});

beforeEach(() => {
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
});

afterEach(() => {
  driver.close();
});

describe("SqliteAdapter — typed @db.default literals", () => {
  it("CREATE TABLE renders each literal as a typed DEFAULT", async () => {
    const table = space.getTable(fx.TypedDefaults);
    await table.dbAdapter.ensureTable();
    const { sql } = driver.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'typed_defaults'",
    )!;
    expect(sql).toMatchInlineSnapshot(
      `"CREATE TABLE "typed_defaults" ("id" INTEGER PRIMARY KEY, "attempts" REAL NOT NULL DEFAULT 0, "delta" REAL NOT NULL DEFAULT -1.5, "enabled" INTEGER NOT NULL DEFAULT 1, "archived" INTEGER NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT 'active', "price" REAL NOT NULL DEFAULT 10.5)"`,
    );
  });

  it("a row inserted outside the SDK gets the defaults; the SDK reads them typed", async () => {
    const table = space.getTable(fx.TypedDefaults);
    await table.dbAdapter.ensureTable();
    driver.exec(`INSERT INTO "typed_defaults" ("id") VALUES (1)`);
    expect(await table.findById(1)).toEqual({
      id: 1,
      attempts: 0,
      delta: -1.5,
      enabled: true,
      archived: false,
      status: "active",
      // SQLite keeps a decimal as REAL: the trailing zero is not stored
      price: "10.5",
    });
  });
});
