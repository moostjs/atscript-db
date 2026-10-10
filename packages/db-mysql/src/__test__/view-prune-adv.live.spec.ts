import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { defineViewPruneAdvCases, seedViewPruneAdv } from "../../../db/test-kit/view-prune-cases";
import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// Server-gated (see view-prune.live.spec.ts): view read pruning over the
// adversarial fixture — collations, a boolean key pin, alias chains.

const DB = "r15_views_prune_adv";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let driver: Mysql2Driver;
let pruned: DbSpace;
let plain: DbSpace;

describe.skipIf(!reachable)("[mysql live] view read pruning — adversarial", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/view-prune-adv.as");
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    pruned = new DbSpace(() => new MysqlAdapter(driver));
    plain = new DbSpace(() => new MysqlAdapter(driver, { viewJoinPruning: false }));
    const result = await syncSchema(pruned, [
      fx.VaCode,
      fx.VaBinCode,
      fx.VaTier,
      fx.VaOwner,
      fx.VaEvent,
      fx.VaItem,
      fx.VaItemView,
      fx.VaInnerChainView,
    ]);
    expect(result.status).toBe("synced");
    await seedViewPruneAdv(pruned, fx);
  });

  afterAll(async () => {
    await driver?.close();
    await dropMysqlDatabase(DB);
  });

  it("droppable joins are recognised", () => {
    expect(pruned.getView(fx.VaItemView as never).readPlan(["id"])?.dropped).toHaveLength(5);
  });

  defineViewPruneAdvCases("MySQL", () => ({ fx, pruned, plain }), { binView: false });
});
