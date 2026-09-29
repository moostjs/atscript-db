import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { createTestSpace, prepareFixtures } from "./test-utils";

// Cross-adapter projection parity (since 0.1.145). Twin of
// db-sqlite/src/__test__/projection-parity.spec.ts — keep the cases identical.
// The memory adapter used to add the primary key to every inclusion
// projection (mirroring Mongo's `_id`), so a projected response differed
// from the SQL adapters'.

let fx: Record<string, any>;
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
  const space = createTestSpace();
  tables = { coded: space.getTable(fx.ParityCoded), lines: space.getTable(fx.ParityLine) };
  await tables.coded.insertMany(structuredClone(CODED));
  await tables.lines.insertMany(structuredClone(LINES));
});

describe("memory: projection parity with the SQL adapters", () => {
  parityCases(() => tables);
});
