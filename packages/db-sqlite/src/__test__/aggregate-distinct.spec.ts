import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

// countDistinct (grouped queries and views) and conditional view aggregates
// against a real in-memory SQLite, since 0.1.136. The same data and
// expectations run on MongoDB in db-mongo's agg-count-distinct-server.spec.ts.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/agg-distinct.as");
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  const result = await new SchemaSync(space).run(
    [fx.AdCustomer, fx.AdOrder, fx.AdCityStats, fx.AdBusyCities],
    { force: true },
  );
  expect(result.status).toBe("synced");

  await space.getTable(fx.AdCustomer).insertMany([
    { id: 1, name: "Ann", vip: true },
    { id: 2, name: "Bob", vip: false },
    { id: 3, name: "Cid", vip: false },
  ]);
  await space.getTable(fx.AdOrder).insertMany([
    { id: 1, city: "Paris", customerId: 1, status: "paid", amount: 10 },
    { id: 2, city: "Paris", customerId: 1, status: "paid", amount: 20 },
    { id: 3, city: "Paris", customerId: 2, status: "open", amount: 5 },
    { id: 4, city: "Paris", status: "paid" },
    { id: 5, city: "Paris", customerId: null, status: "open", amount: 7 },
    { id: 6, city: "Lyon", customerId: 3, status: "open", amount: 4 },
    { id: 7, city: "Lyon", customerId: 3, status: "open", amount: null },
    { id: 8, city: "Rome", customerId: 1, status: "paid", amount: 30 },
  ]);
});

afterAll(() => {
  driver?.close();
});

const distinct = (field: string, as = "n") => ({ $fn: "countDistinct", $field: field, $as: as });

describe("SQLite countDistinct — grouped queries", () => {
  it("counts distinct non-null values per group", async () => {
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

  it("filters ($having) and counts ($count) on the alias", async () => {
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

  it("counts over the whole table without $groupBy (default alias)", async () => {
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

  // `amount` is stored as `amount_cents` (@db.column): the default alias must
  // be the logical `sum_amount`, and $having / $sort must resolve it.
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
});

describe("SQLite views — conditional aggregates and countDistinct", () => {
  it("aggregates only the matching rows; a group without matches sums to 0, avg / min to null", async () => {
    const rows = await space
      .getView(fx.AdCityStats)
      .findMany({ filter: {}, controls: { $sort: { city: 1 } } } as never);
    expect(rows).toEqual([
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
    const rows = await space
      .getView(fx.AdBusyCities)
      .findMany({ filter: {}, controls: {} } as never);
    expect(rows).toEqual([{ city: "Paris", buyers: 2, paidOrders: 3 }]);
  });

  it("filters and sorts the view on a conditional column", async () => {
    const rows = await space.getView(fx.AdCityStats).findMany({
      filter: { paidTotal: { $gt: 0 } },
      controls: { $sort: { paidTotal: -1, city: -1 }, $select: ["city", "paidTotal"] },
    } as never);
    expect(rows).toEqual([
      { city: "Rome", paidTotal: 30 },
      { city: "Paris", paidTotal: 30 },
    ]);
  });
});
