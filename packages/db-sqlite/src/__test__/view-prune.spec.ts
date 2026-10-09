import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace, type AtscriptDbView } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import { buildViewSelect } from "@atscript/db-sql-tools";

import {
  defineViewPruneCases,
  randomRead,
  seedViewPrune,
  vpRandom,
} from "../../../db/test-kit/view-prune-cases";
import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { sqliteDialect } from "../sql-builder";
import { prepareFixtures, RecordingDriver } from "./test-utils";

// View read pruning on SQLite (since 0.1.153): a read that needs only some
// of a managed view's LEFT joins reads an inline definition without them.

let fx: Record<string, any>;
let driver: RecordingDriver;
let pruned: DbSpace;
let plain: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-prune.as");
  driver = new RecordingDriver(new BetterSqlite3Driver(":memory:"));
  pruned = new DbSpace(() => new SqliteAdapter(driver));
  plain = new DbSpace(() => new SqliteAdapter(driver, { viewJoinPruning: false }));
  const result = await new SchemaSync(pruned).run(
    [
      fx.VpRegion,
      fx.VpCustomer,
      fx.VpProduct,
      fx.VpStatus,
      fx.VpNote,
      fx.VpOrder,
      fx.VpOrderView,
      fx.VpEuView,
      fx.VpPartialView,
    ],
    { force: true },
  );
  expect(result.entries.filter((e) => e.status === "error")).toEqual([]);
  await seedViewPrune(pruned, fx);
});

afterAll(() => {
  driver?.close();
});

/** The statements a read ran. */
async function statementsOf(fn: () => Promise<unknown>): Promise<string[]> {
  driver.statements.length = 0;
  await fn();
  return [...driver.statements];
}

const view = (type: unknown) => pruned.getView(type as never) as AtscriptDbView;

describe("SQLite view read pruning — SQL", () => {
  it("COUNT(*) reads only the entry table and the joins that may multiply rows", async () => {
    const [sql] = await statementsOf(() => view(fx.VpOrderView).count());
    expect(sql).toBe(
      'SELECT COUNT(*) as cnt FROM (SELECT "vp_orders"."id" AS "id", "vp_orders"."status" AS "status", ' +
        '"vp_orders"."amount" AS "amount", "vp_statuses"."label" AS "statusLabel" FROM "vp_orders" ' +
        'LEFT JOIN "vp_statuses" ON "vp_statuses"."code" = "vp_orders"."status") AS "vp_order_view" WHERE 1=1',
    );
  });

  it("a selected joined column keeps its join and the joins its ON clause reads", async () => {
    const [sql] = await statementsOf(() =>
      view(fx.VpOrderView).findMany({
        filter: {},
        controls: { $select: ["id", "regionName"], $limit: 1 },
      } as never),
    );
    expect(sql).toContain('LEFT JOIN "vp_customers"');
    expect(sql).toContain('LEFT JOIN "vp_regions"');
    expect(sql).not.toContain("vp_products");
    expect(sql).not.toContain("vp_notes");
    expect(sql).not.toContain('AS "VpShipRegion"');
  });

  it("a computed column keeps the joins of its operands", async () => {
    const [sql] = await statementsOf(() =>
      view(fx.VpOrderView).findMany({ filter: {}, controls: { $select: ["tax"] } } as never),
    );
    expect(sql).toContain('LEFT JOIN "vp_regions"');
    expect(sql).not.toContain("vp_products");
  });

  it("a read of every column reads the stored view", async () => {
    const [sql] = await statementsOf(() =>
      view(fx.VpOrderView).findMany({ filter: {}, controls: {} } as never),
    );
    expect(sql).toBe('SELECT * FROM "vp_order_view" WHERE 1=1');
  });

  it("viewJoinPruning: false reads the stored view", async () => {
    const [sql] = await statementsOf(() => plain.getView(fx.VpOrderView as never).count());
    expect(sql).toBe('SELECT COUNT(*) as cnt FROM "vp_order_view" WHERE 1=1');
  });

  it("a filter on a joined column keeps that join", async () => {
    const [sql] = await statementsOf(() =>
      view(fx.VpOrderView).count({ filter: { productTitle: "a-EU" } } as never),
    );
    expect(sql).toContain('LEFT JOIN "vp_products"');
    expect(sql).not.toContain("vp_customers");
  });

  it("an inner join and a join the view filter reads are kept", async () => {
    const [sql] = await statementsOf(() => view(fx.VpEuView).count());
    expect(sql).toContain('JOIN "vp_customers"');
    expect(sql).toContain('LEFT JOIN "vp_regions" AS "VpShipRegion"');
    expect(sql).not.toContain("vp_products");
  });

  it("a join pinning part of a unique key is never dropped", async () => {
    expect(view(fx.VpPartialView).readPlan(["id"])).toBeUndefined();
    const [sql] = await statementsOf(() => view(fx.VpPartialView).count());
    expect(sql).toBe('SELECT COUNT(*) as cnt FROM "vp_partial_view" WHERE 1=1');
  });

  it("a reference to a dropped column fails loudly", () => {
    const v = view(fx.VpOrderView);
    const variant = v.readPlan(["id"])!;
    expect(variant.droppedColumns).toContain("customerName");
    const inner = buildViewSelect(sqliteDialect, variant.plan, variant.columns, (ref) =>
      v.resolveFieldRef(ref),
    );
    expect(() => driver.all(`SELECT "customerName" FROM (${inner}) AS "vp_order_view"`)).toThrow(
      /no such column/,
    );
  });
});

describe("SQLite view read pruning — differential coverage", () => {
  it("most randomized reads are pruned (the differential exercises pruning)", async () => {
    const rnd = vpRandom(29);
    let prunedReads = 0;
    const total = 150;
    for (let i = 0; i < total; i++) {
      const { op, query } = randomRead(rnd);
      const sql = await statementsOf(() => (view(fx.VpOrderView) as any)[op](query));
      if (sql.some((s) => s.includes(') AS "vp_order_view"'))) prunedReads++;
    }
    expect(prunedReads / total).toBeGreaterThan(0.5);
  });
});

defineViewPruneCases("SQLite", () => ({ fx, pruned, plain }));
