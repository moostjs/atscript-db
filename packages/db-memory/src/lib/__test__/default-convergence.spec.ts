import { describe, beforeAll, beforeEach } from "vite-plus/test";
import type { DbSpace } from "@atscript/db";

import { createTestSpace, prepareFixtures } from "./test-utils";
import { defineDefaultConvergenceCases } from "../../../../db/test-kit/default-convergence-cases";

// The memory adapter diffs against the stored snapshot (no live
// introspection): a forced re-sync of every default kind stays in sync, and
// an applied FK change is reported on the run entry like the plan.

let fx: Record<string, any>;
let space: DbSpace;

describe("Memory — forced sync converges over every default kind", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/default-kinds.as");
  });

  beforeEach(() => {
    space = createTestSpace();
  });

  defineDefaultConvergenceCases(() => ({ fx, space }));
});
