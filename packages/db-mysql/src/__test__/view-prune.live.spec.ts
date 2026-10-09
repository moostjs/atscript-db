import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace, UniquSelect, type DbQuery } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { defineViewPruneCases, seedViewPrune, vpData } from "../../../db/test-kit/view-prune-cases";
import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";

// Live DDL against a real server is slow under the parallel workspace run.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// Server-gated: runs against a live MySQL when one is reachable, skips
// otherwise (CI has no server). Override the server with
// `ATSCRIPT_MYSQL_TEST_URL` (no database in the URL — the spec creates and
// drops its own `r15_views_prune` database).
//
// View read pruning (since 0.1.153): MySQL never eliminates an unused LEFT
// JOIN itself, so a pruned read must (a) return what the stored view returns
// and (b) MERGE its inline definition — a materialized derived table under a
// paged read would scan the whole view.

const SERVER_URL = process.env.ATSCRIPT_MYSQL_TEST_URL ?? "mysql://root:test@127.0.0.1:33071";
const DB = "r15_views_prune";

async function adminQuery(sql: string): Promise<boolean> {
  try {
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection({ uri: SERVER_URL, connectTimeout: 5000 });
    try {
      await conn.query(sql);
    } finally {
      await conn.end();
    }
    return true;
  } catch {
    return false;
  }
}

const reachable = await adminQuery("SELECT 1");

/** Records every read statement (and its params). */
class RecordingDriver extends Mysql2Driver {
  readonly reads: Array<{ sql: string; params: unknown[] }> = [];
  override all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    this.reads.push({ sql, params: params ?? [] });
    return super.all<T>(sql, params);
  }
  override get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    this.reads.push({ sql, params: params ?? [] });
    return super.get<T>(sql, params);
  }
}

let fx: Record<string, any>;
let driver: RecordingDriver;
let pruned: DbSpace;
let plain: DbSpace;

/** The tables EXPLAIN lists for a statement — `<derivedN>` marks a materialized derived table. */
async function explainTables(sql: string, params: unknown[], mergeOff = false): Promise<string[]> {
  const conn = await driver.getConnection();
  try {
    if (mergeOff) await conn.exec("SET SESSION optimizer_switch='derived_merge=off'");
    const rows = await conn.all<{ table: string | null }>(`EXPLAIN ${sql}`, params);
    return rows.map((r) => r.table ?? "");
  } finally {
    if (mergeOff) await conn.exec("SET SESSION optimizer_switch='derived_merge=on'");
    conn.release();
  }
}

/** The statement one read ran. */
async function lastRead(fn: () => Promise<unknown>): Promise<{ sql: string; params: unknown[] }> {
  driver.reads.length = 0;
  await fn();
  return driver.reads.at(-1)!;
}

const orderView = () => pruned.getView(fx.VpOrderView as never) as any;

describe.skipIf(!reachable)("[mysql live] view read pruning", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/view-prune.as");
    await adminQuery(`DROP DATABASE IF EXISTS \`${DB}\``);
    await adminQuery(`CREATE DATABASE \`${DB}\``);
    driver = new RecordingDriver(`${SERVER_URL}/${DB}`);
    pruned = new DbSpace(() => new MysqlAdapter(driver));
    plain = new DbSpace(() => new MysqlAdapter(driver, { viewJoinPruning: false }));
    const result = await syncSchema(pruned, [
      fx.VpRegion,
      fx.VpCustomer,
      fx.VpProduct,
      fx.VpStatus,
      fx.VpNote,
      fx.VpOrder,
      fx.VpOrderView,
      fx.VpEuView,
      fx.VpPartialView,
    ]);
    expect(result.status).toBe("synced");
    await seedViewPrune(pruned, fx, vpData());
  });

  afterAll(async () => {
    await driver?.close();
    await adminQuery(`DROP DATABASE IF EXISTS \`${DB}\``);
  });

  describe("plans", () => {
    it("COUNT(*) merges to the entry table plus the joins that may multiply rows", async () => {
      const { sql, params } = await lastRead(() => orderView().count());
      expect(sql).toContain("/*+ MERGE(`vp_order_view`) */");
      expect((await explainTables(sql, params)).toSorted()).toEqual(["vp_orders", "vp_statuses"]);
    });

    it("the stored view probes every join", async () => {
      const { sql, params } = await lastRead(() => plain.getView(fx.VpOrderView as never).count());
      expect(sql).toBe("SELECT COUNT(*) as cnt FROM `vp_order_view` WHERE 1=1");
      expect((await explainTables(sql, params)).length).toBeGreaterThanOrEqual(7);
    });

    it("a paged read merges (no materialized derived table)", async () => {
      const { sql, params } = await lastRead(() =>
        orderView().findMany({
          filter: { amount: { $gt: 100 } },
          controls: { $select: ["id", "customerName"], $sort: { id: 1 }, $limit: 10 },
        }),
      );
      const tables = await explainTables(sql, params);
      expect(tables.some((t) => t.startsWith("<derived"))).toBe(false);
      expect(tables).toContain("vp_customers");
      expect(tables).not.toContain("vp_products");
    });

    it("the MERGE hint keeps merging with derived_merge=off", async () => {
      const { sql, params } = await lastRead(() =>
        orderView().findMany({
          filter: {},
          controls: { $select: ["id", "lastNote"], $sort: { id: 1 }, $limit: 5 },
        }),
      );
      const tables = await explainTables(sql, params, true);
      expect(tables.some((t) => t.startsWith("<derived"))).toBe(false);
      // …whereas the stored view materializes under that setting
      const byName = await explainTables("SELECT id FROM `vp_order_view` LIMIT 5", [], true);
      expect(byName.some((t) => t.startsWith("<derived"))).toBe(true);
    });

    it("per-partition pages and grouped counts hint their inner query block", async () => {
      const query = {
        filter: {},
        controls: { $select: new UniquSelect(["id", "status"]), $sort: { id: 1 }, $limit: 2 },
      } as unknown as DbQuery;
      const { sql, params } = await lastRead(() =>
        pruned.getAdapter(fx.VpOrderView).findManyPerPartition(query, ["status"]),
      );
      expect(sql).toContain("/*+ MERGE(`vp_order_view`) */");
      const tables = await explainTables(sql, params, true);
      // the window's own derived table is expected; the view's definition is merged into it
      expect(tables.filter((t) => t.startsWith("<derived"))).toHaveLength(1);
      expect(tables).toContain("vp_orders");
      const rows = await pruned.getAdapter(fx.VpOrderView).findManyPerPartition(query, ["status"]);
      const same = await plain.getAdapter(fx.VpOrderView).findManyPerPartition(query, ["status"]);
      expect(rows).toEqual(same);

      const grouped = await lastRead(() =>
        orderView().aggregate({
          filter: {},
          controls: {
            $groupBy: ["regionName"],
            $select: ["regionName", { $fn: "count", $field: "*", $as: "n" }],
            $count: true,
          },
        }),
      );
      const groupedTables = await explainTables(grouped.sql, grouped.params, true);
      expect(groupedTables.filter((t) => t.startsWith("<derived"))).toHaveLength(1);
      expect(groupedTables).not.toContain("vp_products");
    });
  });

  defineViewPruneCases("MySQL", () => ({ fx, pruned, plain }));
});
