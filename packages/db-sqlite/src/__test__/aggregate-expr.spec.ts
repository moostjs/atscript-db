import { expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { AE_ROWS, defineAggregateExprCases } from "../../../db/test-kit/aggregate-expr-cases";
import { prepareFixtures } from "./test-utils";

// Query-time arithmetic and first / last against a real in-memory SQLite
// (since 0.1.148): the shared case table every adapter runs.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/agg-expr.as");
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  const result = await new SchemaSync(space).run([fx.AeIssue], { force: true });
  expect(result.status).toBe("synced");
  await space.getTable(fx.AeIssue).insertMany(AE_ROWS as never);
});

afterAll(() => {
  driver?.close();
});

defineAggregateExprCases("SQLite", () => space.getTable(fx.AeIssue) as never);
