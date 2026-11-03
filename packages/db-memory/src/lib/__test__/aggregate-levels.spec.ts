import type { DbSpace } from "@atscript/db";
import { beforeAll } from "vite-plus/test";

import { AL_ROWS, defineAggregateLevelCases } from "../../../../db/test-kit/aggregate-levels-cases";
import { createTestSpace, prepareFixtures } from "./test-utils";

// countDistinct over a field list, conditional aggregates (`$where`) and
// two-level aggregates (`$from`) on the in-memory adapter (since 0.1.168):
// the shared case table every adapter runs.

let fx: Record<string, any>;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/agg-levels.as");
  space = createTestSpace();
  await space.getTable(fx.AlSale).insertMany(AL_ROWS as never);
});

// A NULL nested group key comes back as `{ shipping: { city: null } }`, like
// single-level grouping by `shipping.city` (see memory-aggregate-levels.spec.ts).
defineAggregateLevelCases("memory", () => space.getTable(fx.AlSale), {
  nullNestedKey: { city: null },
  arrayFilters: true,
});
