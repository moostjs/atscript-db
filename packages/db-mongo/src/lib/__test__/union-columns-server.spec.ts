import { AtscriptDbTable, DbSpace } from "@atscript/db";
import type { MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// `T | null` and unions of objects (since 0.1.155): the reads, nested-path
// filters and sorts the relational adapters give (`union-columns.spec.ts` there).

const card = { kind: "card", card: "4111", amount: 10 };
const bank = { kind: "bank", iban: "DE89", amount: 20 };
const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

describe("MongoAdapter — union fields", () => {
  let server: any;
  let client: MongoClient;
  let orders: AtscriptDbTable;
  let space: DbSpace;
  let fx: Record<string, any>;

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/union-columns.as");
    const { UcOrder } = fx;
    const { MongoMemoryServer } = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server = await MongoMemoryServer.create();
    client = new MC(server.getUri());
    await client.connect();
    space = new DbSpace(() => new MongoAdapter(client.db("test"), client));
    orders = space.getTable(UcOrder);
    await space.getAdapter(UcOrder).ensureTable();
    await space.getAdapter(UcOrder).syncIndexes();
    await orders.insertMany([
      { id: 1, qty: null, payment: card, refund: null, extra: "x" },
      { id: 2, qty: 5, payment: bank, refund: bank, extra: card },
    ] as any);
  }, 60000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  const find = (filter: Record<string, unknown>, controls: Record<string, unknown> = {}) =>
    orders.findMany({ filter, controls } as any) as Promise<Array<Record<string, any>>>;

  it("reads null and the stored member back", async () => {
    const rows = await find({}, { $sort: { id: 1 } });
    expect(rows.map(({ _id, ...row }) => row)).toEqual([
      { id: 1, qty: null, payment: card, refund: null, extra: "x" },
      { id: 2, qty: 5, payment: bank, refund: bank, extra: card },
    ]);
  });

  it("filters and sorts by a nested path of a union of objects", async () => {
    expect(ids((await find({ "payment.card": "4111" })) as any)).toEqual([1]);
    expect(ids((await find({ "refund.iban": "DE89" })) as any)).toEqual([2]);
    expect(ids((await find({ "refund.kind": null })) as any)).toEqual([1]);
    expect(ids((await find({}, { $sort: { "payment.amount": -1 } })) as any)).toEqual([2, 1]);
  });

  it("switching the member by patch replaces the object", async () => {
    await orders.updateOne({ id: 1, payment: bank, refund: card } as any);
    const [{ _id, ...row }] = await find({ id: 1 });
    expect(row).toEqual({ id: 1, qty: null, payment: bank, refund: card, extra: "x" });
  });

  it("a unique index over a `| null` field lets several documents hold null", async () => {
    await space.getAdapter(fx.UcCoded).ensureTable();
    await space.getAdapter(fx.UcCoded).syncIndexes();
    const coded = space.getTable(fx.UcCoded) as any;
    await coded.insertMany([
      { id: 1, code: null },
      { id: 2, code: null },
      { id: 3, code: "A" },
    ]);
    await expect(coded.insertOne({ id: 4, code: "A" })).rejects.toThrow();
  });

  it("null tests on an object: none of its fields holds a value", async () => {
    await space.getAdapter(fx.UcNote).ensureTable();
    const notes = space.getTable(fx.UcNote) as any;
    await notes.insertMany([
      { id: 1, meta: {} },
      { id: 2, meta: { tag: "x" } },
      { id: 3 },
      { id: 4, meta: { tag: null } },
    ]);
    const noteIds = async (filter: Record<string, unknown>) =>
      ids(await notes.findMany({ filter, controls: { $sort: { id: 1 } } }));
    expect(await noteIds({ meta: null })).toEqual([1, 3, 4]);
    expect(await noteIds({ meta: { $ne: null } })).toEqual([2]);
    expect(await noteIds({ meta: { $exists: true } })).toEqual([2]);
  });

  it("patches: a renamed merge object merges; @db.json and `T | null` objects are replaced", async () => {
    const profiles = space.getTable(fx.UcProfile);
    const full = { name: "A", age: 1 };
    await profiles.insertOne({
      id: 1,
      merged: full,
      blob: full,
      maybe: full,
      rblob: full,
      rmaybe: full,
    } as any);
    await profiles.updateOne({
      id: 1,
      merged: { age: 5 },
      blob: { name: "B" },
      maybe: { name: "C" },
      rblob: { name: "D" },
      rmaybe: { name: "E" },
    } as any);
    const row = (await profiles.findOne({ filter: { id: 1 } } as any)) as Record<string, any>;
    expect(row.merged).toEqual({ name: "A", age: 5 });
    expect(row.blob).toEqual({ name: "B" });
    expect(row.maybe).toEqual({ name: "C" });
    // renamed (`@db.column`): replaced under the stored name too
    expect(row.rblob).toEqual({ name: "D" });
    expect(row.rmaybe).toEqual({ name: "E" });
  });
});
