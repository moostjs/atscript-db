import { expect, beforeAll } from "vite-plus/test";
import type { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { AE_ROWS, defineAggregateExprCases } from "../../../../db/test-kit/aggregate-expr-cases";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Query-time arithmetic and first / last on the in-memory adapter (since
// 0.1.148): the shared case table every adapter runs.

let fx: Record<string, any>;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/agg-expr.as");
  space = createTestSpace();
  const result = await new SchemaSync(space).run([fx.AeIssue], { force: true });
  expect(result.status).toBe("synced");
  await space.getTable(fx.AeIssue).insertMany(AE_ROWS as never);
});

defineAggregateExprCases("Memory", () => space.getTable(fx.AeIssue) as never);
