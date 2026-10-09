import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { defineViewPruneAdvCases, seedViewPruneAdv } from "../../../db/test-kit/view-prune-cases";
import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let pruned: DbSpace;
let plain: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-prune-adv.as");
  driver = new BetterSqlite3Driver(":memory:");
  pruned = new DbSpace(() => new SqliteAdapter(driver));
  plain = new DbSpace(() => new SqliteAdapter(driver, { viewJoinPruning: false }));
  const result = await new SchemaSync(pruned).run(
    [
      fx.VaCode,
      fx.VaBinCode,
      fx.VaTier,
      fx.VaOwner,
      fx.VaEvent,
      fx.VaItem,
      fx.VaItemView,
      fx.VaInnerChainView,
      fx.VaBinView,
    ],
    { force: true },
  );
  expect(result.entries.filter((e) => e.status === "error")).toEqual([]);
  await seedViewPruneAdv(pruned, fx);
});

afterAll(() => driver?.close());

describe("SQLite adversarial: the shapes prune", () => {
  it("droppable joins are recognised", () => {
    const view = pruned.getView(fx.VaItemView as never);
    expect(view.readPlan(["id"])?.dropped).toEqual([
      "va_codes",
      "va_owners",
      "VaBoss",
      "va_tiers",
      "VaLastEvent",
    ]);
    expect(pruned.getView(fx.VaBinView as never).readPlan(["id"])).toBeUndefined();
  });
});

defineViewPruneAdvCases("SQLite", () => ({ fx, pruned, plain }));
