import { randomBytes } from "node:crypto";
import { describe, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import type { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import {
  defineMergeWholeValueCases,
  mergeOnJsonField,
} from "../../../db/test-kit/merge-whole-value-cases";
import { prepareFixtures } from "./test-utils";

let MwvItem: any;

describe("SqliteAdapter — a merge strategy below a whole value", () => {
  let driver: BetterSqlite3Driver;
  let items: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ({ MwvItem } = await import("./fixtures/merge-whole-value.as"));
    mergeOnJsonField(MwvItem);
  });

  beforeEach(async () => {
    driver = new BetterSqlite3Driver(":memory:");
    const space = new DbSpace(() => new SqliteAdapter(driver), {
      encryption: { defaultKeyId: "k1", keys: { k1: randomBytes(32) } },
    });
    items = space.getTable(MwvItem);
    await items.ensureTable();
  });

  afterEach(() => driver.close());

  defineMergeWholeValueCases(() => items);
});
