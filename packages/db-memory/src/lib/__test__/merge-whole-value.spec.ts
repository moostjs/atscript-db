import { randomBytes } from "node:crypto";
import { DbSpace, type AtscriptDbTable } from "@atscript/db";
import { describe, beforeAll, beforeEach } from "vite-plus/test";

import {
  defineMergeWholeValueCases,
  mergeOnJsonField,
} from "../../../../db/test-kit/merge-whole-value-cases";
import { MemoryAdapter } from "../memory-adapter";
import { bootstrapStoredTables, prepareFixtures } from "./test-utils";

let MwvItem: any;

describe("MemoryAdapter — a merge strategy below a whole value", () => {
  let items: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ({ MwvItem } = await import("./fixtures/merge-whole-value.as"));
    mergeOnJsonField(MwvItem);
  });

  beforeEach(async () => {
    const space = new DbSpace(() => new MemoryAdapter(), {
      encryption: { defaultKeyId: "k1", keys: { k1: randomBytes(32) } },
    });
    items = space.getTable(MwvItem);
    await bootstrapStoredTables(space, [MwvItem]);
  });

  defineMergeWholeValueCases(() => items);
});
