import { describe, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";
import {
  defineBulkWritesCases,
  type TBulkWriteTables,
} from "../../../../db/test-kit/bulk-writes-cases";

// The memory adapter has no native bounded writes: the core reads the first
// keys in order, then writes filter AND keys; cascades are application-level
// and pin the keys first (since 0.1.162).

let fx: Record<string, any>;
let t: TBulkWriteTables;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/bulk-writes.as");
});

beforeEach(async () => {
  const space = createTestSpace();
  await bootstrapStoredTables(space, [fx.BwTask, fx.BwOwner, fx.BwItem]);
  t = {
    tasks: space.getTable(fx.BwTask),
    owners: space.getTable(fx.BwOwner),
    items: space.getTable(fx.BwItem),
  };
});

describe("MemoryAdapter — bounded writes, @db.onUpdate.inc, validated bulk payloads", () => {
  defineBulkWritesCases({
    tables: () => t,
    boards: async () => {
      const space = createTestSpace();
      await bootstrapStoredTables(space, [fx.BwBoard]);
      return space.getTable(fx.BwBoard);
    },
    bounded: "core emulation",
    cascade: "application",
  });
});
