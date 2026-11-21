import { describe, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { defineNestedArrayOpsCases } from "../../../db/test-kit/nested-array-ops-cases";
import { prepareFixtures } from "./test-utils";

let NaoItem: any;

// Array operators on an array inside a (flattened) nested object, at every
// depth and for both patch strategies of the parents. These results are the
// reference the in-memory adapter matches since 0.1.182.

describe("SqliteAdapter — array operators inside nested objects", () => {
  let driver: BetterSqlite3Driver;
  let items: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ({ NaoItem } = await import("./fixtures/nested-array-ops.as"));
  });

  beforeEach(async () => {
    driver = new BetterSqlite3Driver(":memory:");
    items = new AtscriptDbTable(NaoItem, new SqliteAdapter(driver));
    await items.ensureTable();
  });

  afterEach(() => driver.close());

  defineNestedArrayOpsCases(() => items);
});
