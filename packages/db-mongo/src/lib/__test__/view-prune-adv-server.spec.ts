import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import {
  defineViewPruneAdvCases,
  seedViewPruneAdv,
} from "../../../../db/test-kit/view-prune-cases";
import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// View read pruning, adversarial shapes against a real MongoDB (since 0.1.153).

let server: any;
let client: MongoClient;
let db: Db;
let pruned: DbSpace;
let plain: DbSpace;
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-prune-adv.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("view_prune_adv");
  pruned = new DbSpace(() => new MongoAdapter(db, client));
  plain = new DbSpace(() => new MongoAdapter(db, client, { viewJoinPruning: false }));
  const result = await new SchemaSync(pruned).run(
    [
      fx.VaCode,
      fx.VaBinCode,
      fx.VaTier,
      fx.VaOwner,
      fx.VaEvent,
      fx.VaItem,
      fx.VaPair,
      fx.VaItemView,
      fx.VaInnerChainView,
      fx.VaBinView,
      fx.VaPairView,
    ],
    { force: true },
  );
  expect(result.status).toBe("synced");
  await seedViewPruneAdv(pruned, fx);
  await pruned.getTable(fx.VaPair as never).insertMany([
    { a: 1, b: 1, label: "p11" },
    { a: 1, b: 2, label: "p12" },
    { a: 2, b: 1, label: "p21" },
  ] as never);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

describe("MongoDB adversarial: composite @meta.id beside an explicit _id", () => {
  it("neither key field alone is a unique key", () => {
    const pairs = pruned.getTable(fx.VaPair as never);
    expect(pairs.uniqueKeySets).toEqual([["_id"], ["a", "b"]]);
    expect(pairs.uniqueProps.has("a")).toBe(false);
  });

  it("a join on one of them is never dropped", async () => {
    expect(pruned.getView(fx.VaPairView as never).readPlan(["id"])).toBeUndefined();
    const on = pruned.getView(fx.VaPairView as never);
    const off = plain.getView(fx.VaPairView as never);
    expect(await on.count({ filter: {} } as never)).toBe(await off.count({ filter: {} } as never));
  });
});

defineViewPruneAdvCases("MongoDB", () => ({ fx, pruned, plain }));
