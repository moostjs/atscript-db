import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { seedViewPrune } from "../../../db/test-kit/view-prune-cases";
import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise (CI has no server). Override the server with
// `ATSCRIPT_PG_TEST_URL` (an admin connection; the spec creates and drops its
// own `r15_views_prune` database).
//
// Why the PostgreSQL adapter does not prune view reads (since 0.1.153): the
// planner itself removes a LEFT JOIN whose target is unique on the join
// clause and unused above it — through a view, on a COUNT(*), for composite
// unique keys, literal-pinned keys and first-row joins alike.

const DB = "r15_views_prune";

const reachable = await pgReachable();

let fx: Record<string, any>;
let driver: PgDriver;
let space: DbSpace;

async function plan(sql: string): Promise<string> {
  const rows = await driver.all<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF) ${sql}`);
  return rows.map((r) => r["QUERY PLAN"]).join("\n");
}

describe.skipIf(!reachable)("[postgres live] native LEFT JOIN removal through views", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/view-prune.as");
    driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
    space = new DbSpace(() => new PostgresAdapter(driver));
    const result = await syncSchema(space, [
      fx.VpRegion,
      fx.VpCustomer,
      fx.VpProduct,
      fx.VpStatus,
      fx.VpNote,
      fx.VpOrder,
      fx.VpOrderView,
      fx.VpEuView,
    ]);
    expect(result.status).toBe("synced");
    await seedViewPrune(space, fx);
    await driver.exec("ANALYZE");
  });

  afterAll(async () => {
    await driver?.close();
    await dropPgDatabase(DB);
  });

  it("the adapter reads views by name", () => {
    expect(space.getAdapter(fx.VpOrderView).viewJoinPruning).toBe(false);
  });

  it("COUNT(*) over the view scans the entry table and the non-unique join only", async () => {
    const text = await plan(`SELECT COUNT(*) FROM "vp_order_view"`);
    expect(text).toContain("vp_orders");
    expect(text).toContain("vp_statuses");
    for (const gone of ["vp_customers", "vp_regions", "vp_products", "vp_notes"]) {
      expect(text).not.toContain(gone);
    }
  });

  it("a page of entry columns does too; a selected joined column keeps its join chain", async () => {
    const page = await plan(`SELECT "id", "amount" FROM "vp_order_view" ORDER BY "id" LIMIT 10`);
    expect(page).not.toContain("vp_customers");
    const joined = await plan(`SELECT "id", "regionName" FROM "vp_order_view" LIMIT 10`);
    expect(joined).toContain("vp_customers");
    expect(joined).toContain("vp_regions");
    expect(joined).not.toContain("vp_products");
  });

  it("a literal-pinned unique key is removed; an inner join is kept", async () => {
    const text = await plan(`SELECT COUNT(*) FROM "vp_eu_view"`);
    expect(text).not.toContain("vp_products");
    expect(text).toContain("vp_customers");
  });
});
