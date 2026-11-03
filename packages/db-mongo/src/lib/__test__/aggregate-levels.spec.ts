import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { AL_ROWS, defineAggregateLevelCases } from "../../../../db/test-kit/aggregate-levels-cases";
import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// countDistinct over a field list, conditional aggregates (`$where`) and
// two-level aggregates (`$from`) against a real MongoDB (mongodb-memory-server),
// since 0.1.168: the shared case table every adapter runs.

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/agg-levels.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("aggregate_levels");
  space = new DbSpace(() => new MongoAdapter(db, client));
  const result = await new SchemaSync(space).run([fx.AlSale], { force: true });
  expect(result.status).toBe("synced");
  await space.getTable(fx.AlSale).insertMany(AL_ROWS as never);
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

const sales = () => space.getTable(fx.AlSale);

// A NULL nested group key comes back as `{ shipping: { city: null } }`, like
// single-level grouping by `shipping.city` (asserted below).
defineAggregateLevelCases("MongoDB", sales, { nullNestedKey: { city: null }, arrayFilters: true });

describe("MongoDB aggregate levels — adapter specifics", () => {
  it("single-level grouping by shipping.city returns { shipping: { city: null } } for a missing city", async () => {
    const rows = await sales().aggregate({
      filter: { id: { $in: [4, 9] } },
      controls: { $groupBy: ["shipping.city"], $select: ["shipping.city"] },
    } as never);
    expect(rows).toEqual([{ shipping: { city: null } }]);
  });

  it("a condition reads NULL like the MongoDB filter: $not / $ne / $nin match a null or missing value", async () => {
    const rows = await sales().aggregate({
      filter: {},
      controls: {
        $select: [
          // amounts: 10, 20, 5, null, 7, null, 4, 30, 1 → not (> 9): 5, null, 7, null, 4, 1
          { $fn: "count", $field: "*", $where: { $not: { amount: { $gt: 9 } } }, $as: "small" },
          // customerId is null on #6 → != 1 holds for #4, #5, #6, #7, #8, #9
          { $fn: "count", $field: "*", $where: { customerId: { $ne: 1 } }, $as: "notFirst" },
          { $fn: "count", $field: "*", $where: { productId: { $nin: [10, 12] } }, $as: "others" },
          {
            $fn: "count",
            $field: "*",
            $where: { "shipping.city": { $exists: false } },
            $as: "noCity",
          },
          { $fn: "count", $field: "*", $where: { status: { $regex: "^pa" } }, $as: "pa" },
          {
            $fn: "count",
            $field: "*",
            $where: { $not: { status: { $regex: "^pa" } } },
            $as: "notPa",
          },
        ],
      },
    } as never);
    expect(rows).toEqual([{ small: 6, notFirst: 6, others: 3, noCity: 2, pa: 5, notPa: 4 }]);
  });

  it("an ungrouped outer level over zero inner rows is still one row ($having on it too)", async () => {
    const controls = {
      $from: {
        $groupBy: ["region"],
        $select: [{ $fn: "count", $field: "*", $as: "n" }],
        $having: { n: { $gt: 100 } },
      },
      $select: [
        { $fn: "count", $field: "*", $as: "groups" },
        { $fn: "sum", $field: "n", $as: "total" },
      ],
    };
    expect(await sales().aggregate({ filter: {}, controls } as never)).toEqual([
      { groups: 0, total: null },
    ]);
    expect(
      await sales().aggregate({ filter: {}, controls: { ...controls, $count: true } } as never),
    ).toEqual([{ count: 1 }]);
    expect(
      await sales().aggregate({
        filter: {},
        controls: { ...controls, $having: { groups: { $gt: 0 } } },
      } as never),
    ).toEqual([]);
    // one inner row survives: the real outer group, not the empty one
    expect(
      await sales().aggregate({
        filter: {},
        controls: { ...controls, $from: { ...controls.$from, $having: { n: { $gt: 3 } } } },
      } as never),
    ).toEqual([{ groups: 1, total: 6 }]);
  });
});
