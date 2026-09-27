import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

// Managed views against a real in-memory SQLite (since 0.1.136): physical
// source names (flattened `__`, `@db.column`), INNER vs LEFT joins, a filter
// on the left-joined side, chained joins, and in / exists predicates.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/views.as");
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  const result = await new SchemaSync(space).run(
    [
      fx.SvCountry,
      fx.SvRegion,
      fx.SvCustomer,
      fx.SvOrder,
      fx.SvCustomerList,
      fx.SvOrdersLeft,
      fx.SvOrdersInner,
      fx.SvOrdersLeftParis,
      fx.SvCustomerGeo,
      fx.SvCityTotals,
    ],
    { force: true },
  );
  expect(result.status).toBe("synced");

  await space.getTable(fx.SvCountry).insertMany([{ id: 1, name: "France" }]);
  await space.getTable(fx.SvRegion).insertMany([
    { id: 10, name: "IDF", countryId: 1 },
    { id: 20, name: "Nowhere-land" },
  ]);
  await space.getTable(fx.SvCustomer).insertMany([
    { id: 1, name: "Ann", address: { city: "Paris", zip: "75001" }, regionId: 10 },
    { id: 2, name: "Bob", address: { city: "Lyon", zip: "69001" }, regionId: 20 },
    { id: 3, name: "Cid", address: { city: "Paris", zip: "75002" } },
    { id: 4, name: "Dan", address: { city: "Nowhere", zip: "00000" } },
  ]);
  await space.getTable(fx.SvOrder).insertMany([
    { id: 100, customerId: 1, amount: 10, status: "paid" },
    { id: 101, customerId: 1, amount: 5, status: "open" },
    { id: 102, customerId: 2, amount: 7, status: "shipped" },
    { id: 103, amount: 3, status: "paid" },
  ]);
});

afterAll(() => {
  driver?.close();
});

async function rows(type: unknown): Promise<Array<Record<string, unknown>>> {
  const view = space.getView(type as never);
  const found = await view.findMany({ filter: {}, controls: { $sort: { id: 1 } } } as never);
  return found as Array<Record<string, unknown>>;
}

describe("SQLite views — physical source columns", () => {
  it("reads flattened and renamed source columns, and expands an object field", async () => {
    expect(await rows(fx.SvCustomerList)).toEqual([
      { id: 1, name: "Ann", city: "Paris", address: { city: "Paris", zip: "75001" } },
      { id: 2, name: "Bob", city: "Lyon", address: { city: "Lyon", zip: "69001" } },
      { id: 3, name: "Cid", city: "Paris", address: { city: "Paris", zip: "75002" } },
    ]);
  });
});

describe("SQLite views — join kinds", () => {
  it("a left join keeps unmatched entry rows with nulls", async () => {
    expect(await rows(fx.SvOrdersLeft)).toEqual([
      { id: 100, customerName: "Ann", customerCity: "Paris" },
      { id: 101, customerName: "Ann", customerCity: "Paris" },
      { id: 102, customerName: "Bob", customerCity: "Lyon" },
      { id: 103, customerName: null, customerCity: null },
    ]);
  });

  it("an inner join drops unmatched entry rows", async () => {
    expect((await rows(fx.SvOrdersInner)).map((r) => r.id)).toEqual([100, 101, 102]);
  });

  it("a filter on the left-joined side acts as an inner join", async () => {
    expect(await rows(fx.SvOrdersLeftParis)).toEqual([
      { id: 100, customerName: "Ann" },
      { id: 101, customerName: "Ann" },
    ]);
  });

  it("chains joins through an earlier join", async () => {
    expect(await rows(fx.SvCustomerGeo)).toEqual([
      { id: 1, name: "Ann", regionName: "IDF", countryName: "France" },
      { id: 2, name: "Bob", regionName: "Nowhere-land", countryName: null },
      { id: 3, name: "Cid", regionName: null, countryName: null },
      { id: 4, name: "Dan", regionName: null, countryName: null },
    ]);
  });

  it("aggregates over a left join with an in-list condition", async () => {
    const view = space.getView(fx.SvCityTotals as never);
    const found = (await view.findMany({
      filter: {},
      controls: { $sort: { city: 1 } },
    } as never)) as Array<Record<string, unknown>>;
    expect(found).toEqual([
      { city: "Lyon", orders: 1, total: 7, customers: 1 },
      { city: "Nowhere", orders: 0, total: null, customers: 1 },
      { city: "Paris", orders: 1, total: 10, customers: 2 },
    ]);
  });
});
