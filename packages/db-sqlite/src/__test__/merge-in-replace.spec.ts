import { describe, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { defineMergeInReplaceCases } from "../../../db/test-kit/merge-in-replace-cases";
import { prepareFixtures } from "./test-utils";

let MirItem: any;

// A merge-strategy object inside a replaced one keeps the children the patch
// leaves out (since 0.1.183; before, the replace of the outer object nulled
// every omitted optional column below it). The same rows as MongoDB.

describe("SqliteAdapter — a merge-strategy object inside a replaced one", () => {
  let driver: BetterSqlite3Driver;
  let items: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ({ MirItem } = await import("./fixtures/merge-in-replace.as"));
  });

  beforeEach(async () => {
    driver = new BetterSqlite3Driver(":memory:");
    items = new AtscriptDbTable(MirItem, new SqliteAdapter(driver));
    await items.ensureTable();
  });

  afterEach(() => driver.close());

  defineMergeInReplaceCases(() => items);
});
