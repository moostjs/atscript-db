import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// countDistinct (grouped queries and views) and conditional view aggregates
// against a real MongoDB (mongodb-memory-server), since 0.1.136. Same data and
// expectations as db-sqlite's aggregate-distinct.spec.ts: SQL semantics — a
// null or missing value is never counted, a conditional SUM with no matching
// row is 0, a conditional AVG / MIN is null.

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/agg-distinct.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("count_distinct");
  space = new DbSpace(() => new MongoAdapter(db, client));

  const result = await new SchemaSync(space).run(
    [fx.AdCustomer, fx.AdOrder, fx.AdCityStats, fx.AdBusyCities],
    { force: true },
  );
  expect(result.status).toBe("synced");

  await space.getTable(fx.AdCustomer).insertMany([
    { id: 1, name: "Ann", vip: true },
    { id: 2, name: "Bob", vip: false },
    { id: 3, name: "Cid", vip: false },
  ] as never);
  await space.getTable(fx.AdOrder).insertMany([
    { id: 1, city: "Paris", customerId: 1, status: "paid", amount: 10 },
    { id: 2, city: "Paris", customerId: 1, status: "paid", amount: 20 },
    { id: 3, city: "Paris", customerId: 2, status: "open", amount: 5 },
    { id: 4, city: "Paris", status: "paid" },
    { id: 5, city: "Paris", customerId: null, status: "open", amount: 7 },
    { id: 6, city: "Lyon", customerId: 3, status: "open", amount: 4 },
    { id: 7, city: "Lyon", customerId: 3, status: "open", amount: null },
    { id: 8, city: "Rome", customerId: 1, status: "paid", amount: 30 },
  ] as never);
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

const distinct = (field: string, as = "n") => ({ $fn: "countDistinct", $field: field, $as: as });

async function viewRows(type: unknown, query: Record<string, unknown>) {
  const found = await space.getView(type as never).findMany(query as never);
  return (found as Array<Record<string, unknown>>).map(({ _id, ...rest }) => rest);
}

describe("MongoDB countDistinct — grouped queries", () => {
  it("counts distinct values, skipping null AND missing ones", async () => {
    const rows = await space.getTable(fx.AdOrder).aggregate({
      filter: {},
      controls: {
        $groupBy: ["city"],
        $select: ["city", distinct("customerId")],
        $sort: { n: -1, city: 1 },
      },
    } as never);
    expect(rows).toEqual([
      { city: "Paris", n: 2 },
      { city: "Lyon", n: 1 },
      { city: "Rome", n: 1 },
    ]);
  });

  it("filters ($having) and counts ($count) on the alias — both see the number", async () => {
    const table = space.getTable(fx.AdOrder);
    const controls = {
      $groupBy: ["city"],
      $select: ["city", distinct("customerId")],
      $having: { n: { $gt: 1 } },
    };
    expect(await table.aggregate({ filter: {}, controls } as never)).toEqual([
      { city: "Paris", n: 2 },
    ]);
    expect(
      await table.aggregate({ filter: {}, controls: { ...controls, $count: true } } as never),
    ).toEqual([{ count: 1 }]);
  });

  it("counts over the whole collection without $groupBy (default alias, renamed field)", async () => {
    const rows = await space.getTable(fx.AdOrder).aggregate({
      filter: {},
      controls: {
        $groupBy: [],
        $select: [
          { $fn: "countDistinct", $field: "status" },
          { $fn: "countDistinct", $field: "amount", $as: "amounts" },
        ],
      },
    } as never);
    expect(rows).toEqual([{ countDistinct_status: 2, amounts: 6 }]);
  });

  it("names a default alias after the LOGICAL field — also over a @db.column rename", async () => {
    const rows = await space.getTable(fx.AdOrder).aggregate({
      filter: {},
      controls: {
        $groupBy: ["city"],
        $select: ["city", { $fn: "sum", $field: "amount" }],
        $having: { sum_amount: { $gt: 10 } },
        $sort: { sum_amount: -1 },
      },
    } as never);
    expect(rows).toEqual([
      { city: "Paris", sum_amount: 42 },
      { city: "Rome", sum_amount: 30 },
    ]);
  });

  it("count(field) no longer counts documents where the field is missing", async () => {
    const rows = await space.getTable(fx.AdOrder).aggregate({
      filter: { city: "Paris" },
      controls: {
        $groupBy: [],
        $select: [{ $fn: "count", $field: "customerId", $as: "withCustomer" }],
      },
    } as never);
    expect(rows).toEqual([{ withCustomer: 3 }]);
  });
});

describe("MongoDB views — conditional aggregates and countDistinct", () => {
  it("aggregates only the matching rows; a group without matches sums to 0, avg / min to null", async () => {
    expect(
      await viewRows(fx.AdCityStats, { filter: {}, controls: { $sort: { city: 1 } } }),
    ).toEqual([
      {
        city: "Lyon",
        orders: 2,
        paidOrders: 0,
        paidWithAmount: 0,
        paidTotal: 0,
        paidAvg: null,
        paidMin: null,
        buyers: 1,
        paidBuyers: 0,
        vipOrders: 0,
      },
      {
        city: "Paris",
        orders: 5,
        paidOrders: 3,
        paidWithAmount: 2,
        paidTotal: 30,
        paidAvg: 15,
        paidMin: 10,
        buyers: 2,
        paidBuyers: 1,
        vipOrders: 2,
      },
      {
        city: "Rome",
        orders: 1,
        paidOrders: 1,
        paidWithAmount: 1,
        paidTotal: 30,
        paidAvg: 30,
        paidMin: 30,
        buyers: 1,
        paidBuyers: 1,
        vipOrders: 1,
      },
    ]);
  });

  it("@db.view.having filters on countDistinct and conditional aliases", async () => {
    expect(await viewRows(fx.AdBusyCities, { filter: {}, controls: {} })).toEqual([
      { city: "Paris", buyers: 2, paidOrders: 3 },
    ]);
  });

  it("filters and sorts the view on a conditional column", async () => {
    const rows = await viewRows(fx.AdCityStats, {
      filter: { paidTotal: { $gt: 0 } },
      controls: { $sort: { paidTotal: -1, city: -1 }, $select: ["city", "paidTotal"] },
    });
    expect(rows).toEqual([
      { city: "Rome", paidTotal: 30 },
      { city: "Paris", paidTotal: 30 },
    ]);
  });
});

describe("MongoDB null helpers — aggregation order (missing < null < every value)", () => {
  it("notNullExpr ($gt null) holds for every value, isNullExpr ($lte null) for null and missing", async () => {
    const { isNullExpr, notNullExpr } = await import("../mongo-view-expr");
    const values: Array<[string, unknown]> = [
      ["zero", 0],
      ["empty", ""],
      ["false", false],
      ["negative", -5],
      ["array", []],
      ["object", {}],
      ["date", new Date(0)],
      ["null", null],
    ];
    const col = db.collection("null_helpers");
    await col.insertMany([...values.map(([name, v]) => ({ name, v })), { name: "missing" }]);
    const rows = await col
      .aggregate([
        { $project: { _id: 0, name: 1, notNull: notNullExpr("$v"), isNull: isNullExpr("$v") } },
      ])
      .toArray();
    const byName = Object.fromEntries(rows.map((r) => [r.name, [r.notNull, r.isNull]]));
    for (const [name] of values.slice(0, -1)) {
      expect(byName[name], name).toEqual([true, false]);
    }
    expect(byName.null).toEqual([false, true]);
    expect(byName.missing).toEqual([false, true]);
  });

  it("$ifNull → $$REMOVE keeps null and missing out of an $addToSet set", async () => {
    const col = db.collection("remove_set");
    await col.insertMany([
      { g: 1, v: "a" },
      { g: 1, v: null },
      { g: 1 },
      { g: 2, v: null },
      { g: 2 },
    ]);
    const rows = await col
      .aggregate([
        { $group: { _id: "$g", set: { $addToSet: { $ifNull: ["$v", "$$REMOVE"] } } } },
        { $project: { _id: 0, g: "$_id", n: { $size: "$set" } } },
        { $sort: { g: 1 } },
      ])
      .toArray();
    expect(rows).toEqual([
      { g: 1, n: 1 },
      { g: 2, n: 0 },
    ]);
  });
});
