import type { AtscriptDbTable, DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { defineNestedArrayOpsCases } from "../../../../db/test-kit/nested-array-ops-cases";
import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

let NaoItem: any;

// Array operators on an array inside a nested object (since 0.1.182 on this
// adapter): the result SQLite gives for the same patch. Before, an operator
// under a replace-strategy object was stored as the array's value
// (`labels: { $insert: [...] }`), and under a merge-strategy one the stored
// items were dropped (`["x"]` + `$insert ["y"]` → `["y"]`).

describe("MemoryAdapter — array operators inside nested objects", () => {
  let space: DbSpace;
  let items: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ({ NaoItem } = await import("./fixtures/nested-array-ops.as"));
  });

  beforeEach(async () => {
    space = createTestSpace();
    items = space.getTable(NaoItem);
    await bootstrapStoredTables(space, [NaoItem]);
  });

  defineNestedArrayOpsCases(() => items);

  it("a nested object without array operators is still replaced whole", async () => {
    await items.insertOne({ id: 1, box: { caption: "c", labels: ["x"] } } as any);
    await items.updateOne({ id: 1, box: { labels: ["z"] } } as any);
    const row = (await items.findOne({ filter: { id: 1 }, controls: {} })) as any;
    expect(row.box).toEqual({ labels: ["z"] });
  });
});
