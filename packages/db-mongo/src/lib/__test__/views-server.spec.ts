import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Managed views against a real MongoDB (mongodb-memory-server), since
// 0.1.136: inner joins drop unmatched documents, left joins keep them, a null
// or missing join key never matches (SQL semantics), compound / non-equality
// conditions, chained joins and aggregates over a left join.

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/views.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("views_server");
  space = new DbSpace(() => new MongoAdapter(db, client));

  const result = await new SchemaSync(space).run(
    [
      fx.MvCountry,
      fx.MvRegion,
      fx.MvCustomer,
      fx.MvOrder,
      fx.MvOrdersLeft,
      fx.MvOrdersInner,
      fx.MvCustomerByCode,
      fx.MvCustomerEligible,
      fx.MvCustomerGeo,
      fx.MvCustomerOrders,
      fx.MvStore,
      fx.MvStoreZips,
      fx.MvZipStats,
    ],
    { force: true },
  );
  expect(result.status).toBe("synced");

  await space.getTable(fx.MvCountry).insertMany([{ id: 1, name: "France" }] as never);
  await space.getTable(fx.MvRegion).insertMany([
    { id: 10, name: "IDF", minScore: 10, countryId: 1, code: "A" },
    { id: 20, name: "NL", minScore: 0 },
  ] as never);
  await space.getTable(fx.MvCustomer).insertMany([
    { id: 1, name: "Ann", profile: { city: "Paris" }, score: 50, regionId: 10, code: "A" },
    { id: 2, name: "Bob", profile: { city: "Lyon" }, score: 5, regionId: 10 },
    { id: 3, name: "Cid", profile: { city: "Paris" }, score: 99 },
    { id: 4, name: "Dan", profile: { city: "Nowhere" }, score: 1, regionId: 20 },
  ] as never);
  await space.getTable(fx.MvOrder).insertMany([
    { id: 100, customerId: 1, amount: 10, status: "paid" },
    { id: 101, customerId: 1, amount: 5, status: "open" },
    { id: 102, customerId: 2, amount: 7, status: "shipped" },
    { id: 103, amount: 3, status: "paid" },
    { id: 104, customerId: 99, amount: 1, status: "paid" },
    { id: 105, customerId: 1, amount: 2, status: "void" },
  ] as never);
  await space.getTable(fx.MvStore).insertMany([
    { id: 1, address: { city: "Paris", zip: "75001" }, qty: 7, cap: 5 },
    { id: 2, address: { city: "Paris", zip: "75002" }, qty: 3, cap: 5 },
    { id: 3, address: { city: "Lyon", zip: "69001" }, qty: 7 },
    { id: 4, address: { city: "Lyon" }, qty: 9, cap: 1 },
  ] as never);
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

async function rows(type: unknown, sort: Record<string, 1 | -1> = { id: 1 }) {
  const found = await space
    .getView(type as never)
    .findMany({ filter: {}, controls: { $sort: sort } } as never);
  return (found as Array<Record<string, unknown>>).map(({ _id, ...rest }) => rest);
}

describe("MongoDB views — join kinds", () => {
  it("a left join keeps unmatched documents; the filter uses physical paths", async () => {
    expect(await rows(fx.MvOrdersLeft)).toEqual([
      { id: 100, customerName: "Ann", city: "Paris" },
      { id: 101, customerName: "Ann", city: "Paris" },
      { id: 102, customerName: "Bob", city: "Lyon" },
      { id: 103, customerName: null, city: null },
      { id: 104, customerName: null, city: null },
    ]);
  });

  it("an inner join drops unmatched documents", async () => {
    expect((await rows(fx.MvOrdersInner)).map((r) => r.id)).toEqual([100, 101, 102, 105]);
  });

  it("a missing local key does not match a missing foreign key", async () => {
    expect(await rows(fx.MvCustomerByCode)).toEqual([{ id: 1, regionName: "IDF" }]);
  });

  it("evaluates a compound condition with a non-equality", async () => {
    expect(await rows(fx.MvCustomerEligible)).toEqual([
      { id: 1, regionName: "IDF" },
      { id: 2, regionName: null },
      { id: 3, regionName: null },
      { id: 4, regionName: "NL" },
    ]);
  });

  it("chains a join through an earlier join", async () => {
    expect(await rows(fx.MvCustomerGeo)).toEqual([
      { id: 1, regionName: "IDF", countryName: "France" },
      { id: 2, regionName: "IDF", countryName: "France" },
      { id: 3, regionName: null, countryName: null },
      { id: 4, regionName: "NL", countryName: null },
    ]);
  });

  it("aggregates over a left join (count of a field skips unmatched rows)", async () => {
    expect(await rows(fx.MvCustomerOrders, { city: 1 })).toEqual([
      { city: "Lyon", orders: 1, total: 7, customers: 1 },
      // $sum over no values is 0 on MongoDB (SQL: NULL)
      { city: "Nowhere", orders: 0, total: 0, customers: 1 },
      { city: "Paris", orders: 1, total: 10, customers: 2 },
    ]);
  });
});

// Since 0.1.137: a `@db.column` on a nested leaf renames nothing on documents
// (the leaf is written, filtered, sorted, grouped and read by views at
// `address.zip`), and a field-to-field view filter comparison excludes a
// null / missing operand like SQL.
describe("MongoDB — nested-leaf @db.column and field-to-field view filters", () => {
  it("stores the nested leaf at its logical path", async () => {
    const doc = await db.collection("mv_stores").findOne({ id: 1 });
    expect(doc).toMatchObject({ address: { city: "Paris", zip: "75001" } });
    expect(doc).not.toHaveProperty("zip_code");
  });

  it("table filter / $sort / $groupBy address the stored path", async () => {
    const table = space.getTable(fx.MvStore);
    const byZip = await table.findMany({
      filter: { "address.zip": "75001" },
      controls: {},
    } as never);
    expect(byZip.map((r: any) => r.id)).toEqual([1]);
    const sorted = await table.findMany({
      filter: {},
      controls: { $sort: { "address.zip": -1 } },
    } as never);
    expect(sorted.map((r: any) => r.id)).toEqual([2, 1, 3, 4]);
    const groups = await table.aggregate({
      filter: { "address.city": "Paris" },
      controls: {
        $select: ["address.zip", { $fn: "count", $field: "*", $as: "n" }],
        $groupBy: ["address.zip"],
        $sort: { "address.zip": 1 },
      },
    } as never);
    expect(groups).toEqual([
      { address: { zip: "75001" }, n: 1 },
      { address: { zip: "75002" }, n: 1 },
    ]);
  });

  it("a view reads the nested leaf; `qty > cap` drops a missing cap", async () => {
    expect(await rows(fx.MvStoreZips)).toEqual([{ id: 1, zip: "75001" }]);
  });

  it("countDistinct over the nested leaf", async () => {
    expect(await rows(fx.MvZipStats, { city: 1 })).toEqual([
      { city: "Lyon", zips: 1 },
      { city: "Paris", zips: 2 },
    ]);
  });
});
