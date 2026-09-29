import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Cross-adapter projection parity (since 0.1.145). Twin of
// db-memory/src/lib/__test__/projection-parity.spec.ts — keep the cases identical.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let tables: { coded: any; lines: any };

const CODED = [
  { id: 1, code: "c1", owner: "u1", note: "n1" },
  { id: 2, code: "c2", owner: "u2" },
];
const LINES = [
  { orderId: 1, lineNo: 1, owner: "u1" },
  { orderId: 1, lineNo: 2, owner: "u2" },
];

/** The SAME expectations run against every adapter's twin of this spec. */
function parityCases(table: () => { coded: any; lines: any }) {
  it("an inclusion projection returns exactly the selected fields — no implicit primary key", async () => {
    const rows = await table().coded.findMany({
      filter: {},
      controls: { $select: ["owner", "code"], $sort: { id: 1 } },
    });
    expect(rows).toEqual([
      { owner: "u1", code: "c1" },
      { owner: "u2", code: "c2" },
    ]);
  });

  it("the map form behaves alike", async () => {
    const row = await table().coded.findOne({
      filter: { id: 2 },
      controls: { $select: { owner: 1 } },
    });
    expect(row).toEqual({ owner: "u2" });
  });

  it("a composite primary key is not added either", async () => {
    const rows = await table().lines.findMany({
      filter: {},
      controls: { $select: ["owner"], $sort: { lineNo: 1 } },
    });
    expect(rows).toEqual([{ owner: "u1" }, { owner: "u2" }]);
  });

  it("a selected primary key is returned", async () => {
    const rows = await table().lines.findMany({
      filter: { owner: "u2" },
      controls: { $select: ["orderId", "lineNo"] },
    });
    expect(rows).toEqual([{ orderId: 1, lineNo: 2 }]);
  });
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/projection-parity.as");
});

beforeEach(async () => {
  driver = new BetterSqlite3Driver(":memory:");
  const space = new DbSpace(() => new SqliteAdapter(driver));
  await new SchemaSync(space).run([fx.ParityCoded, fx.ParityLine], { force: true });
  tables = { coded: space.getTable(fx.ParityCoded), lines: space.getTable(fx.ParityLine) };
  await tables.coded.insertMany(structuredClone(CODED));
  await tables.lines.insertMany(structuredClone(LINES));
});

afterEach(() => {
  driver.close();
});

describe("sqlite: projection parity with the other adapters", () => {
  parityCases(() => tables);
});
