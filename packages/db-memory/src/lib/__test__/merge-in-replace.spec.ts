import type { AtscriptDbTable } from "@atscript/db";
import { describe, beforeAll, beforeEach } from "vite-plus/test";

import { defineMergeInReplaceCases } from "../../../../db/test-kit/merge-in-replace-cases";
import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

let MirItem: any;

// A merge-strategy object inside a replaced one keeps the children the patch
// leaves out (since 0.1.183): the replaced object is then set leaf by leaf,
// the merge object merged into the stored one. Before, the outer object was
// stored as sent, so the merge object lost every child the patch left out.

describe("MemoryAdapter — a merge-strategy object inside a replaced one", () => {
  let items: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ({ MirItem } = await import("./fixtures/merge-in-replace.as"));
  });

  beforeEach(async () => {
    const space = createTestSpace();
    items = space.getTable(MirItem);
    await bootstrapStoredTables(space, [MirItem]);
  });

  defineMergeInReplaceCases(() => items);
});
