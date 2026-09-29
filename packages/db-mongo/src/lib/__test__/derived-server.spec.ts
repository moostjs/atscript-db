import { DbError, DbSpace, DocumentFieldMapper } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Collection, Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// `@db.column.derived` against a real MongoDB (mongodb-memory-server), since
// 0.1.141: nothing is stored for the derived field — every read fills it from
// the source path, queries and indexes address the source path, and schema
// sync never touches (adds, unsets, backfills) the source leaf.

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;

const ROWS = [
  {
    id: 1,
    status: "open",
    payload: { customer: { id: "c1", vip: true, tier: "Gold" }, total: 10 },
    meta: { region: "eu" },
  },
  { id: 2, status: "paid", payload: { customer: { id: "c2", vip: false }, total: 5 } },
  {
    id: 3,
    status: "open",
    payload: { customer: { id: "c1", vip: true }, total: 7 },
    meta: { region: "us" },
  },
];

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/derived.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("derived_server");
  space = new DbSpace(() => new MongoAdapter(db, client));
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

const strip = (rows: Array<Record<string, unknown>>) => rows.map(({ _id, ...rest }) => rest);
const indexKeys = async (col: Collection) =>
  (await col.indexes()).map((i) => JSON.stringify(i.key)).toSorted();

describe("MongoDB: derived columns", () => {
  it("stores nothing for the derived fields, indexes the source path", async () => {
    const result = await new SchemaSync(space).run([fx.DvOrder, fx.DvOrderView], { force: true });
    expect(result.status).toBe("synced");
    const table = space.getTable(fx.DvOrder);
    await table.insertMany(
      ROWS.map((r) => Object.assign({}, r, { customerId: "zzz", amount: 999 })) as never,
    );

    const raw = db.collection("dv_orders");
    const doc = await raw.findOne({ id: 1 });
    expect(doc).not.toHaveProperty("customerId");
    expect(doc).not.toHaveProperty("amount");
    expect(doc).toMatchObject({
      payload: { customer: { id: "c1" }, total: 10 },
      meta_json: { region: "eu" },
    });
    expect(await indexKeys(raw)).toEqual([
      JSON.stringify({ _id: 1 }),
      JSON.stringify({ id: 1 }),
      JSON.stringify({ "meta_json.region": 1 }),
      JSON.stringify({ "payload.customer.id": 1 }),
    ]);
  });

  it("reads fill the derived fields; queries address the source path", async () => {
    const table = space.getTable(fx.DvOrder);
    const rows = await table.findMany({ filter: {}, controls: { $sort: { id: 1 } } });
    expect(strip(rows as never)[0]).toEqual({
      id: 1,
      status: "open",
      payload: { customer: { id: "c1", vip: true, tier: "Gold" }, total: 10 },
      meta: { region: "eu" },
      customerId: "c1",
      vip: true,
      amount: 10,
      region: "eu",
      tier: "Gold",
    });
    expect(rows[1]).toMatchObject({ customerId: "c2", region: null, tier: null });

    const filtered = await table.findMany({
      filter: { customerId: "c1", vip: true },
      controls: { $sort: { amount: -1 }, $select: ["id", "customerId", "amount"] },
    });
    expect(strip(filtered as never)).toEqual([
      { id: 1, customerId: "c1", amount: 10 },
      { id: 3, customerId: "c1", amount: 7 },
    ]);
    // The source does not leak through an inclusion of the derived field only
    expect(filtered[0]).not.toHaveProperty("payload");

    const excluded = await table.findOne({
      filter: { id: 1 },
      controls: { $select: { payload: 0 } },
    });
    expect(excluded).toMatchObject({ customerId: "c1", vip: true, amount: 10 });
    expect(excluded).not.toHaveProperty("payload");

    const grouped = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["customerId"],
        $select: ["customerId", { $fn: "sum", $field: "amount", $as: "total" }],
        $sort: { customerId: 1 },
      },
    } as never);
    expect(grouped).toEqual([
      { customerId: "c1", total: 17 },
      { customerId: "c2", total: 5 },
    ]);
    // The raw controls the mapper receives may carry the single-string
    // `$groupBy` form the path guard accepts — it fills the derived field
    // too (regression: the string branch used to be skipped)
    const raw = [
      { payload: { customer: { id: "c1" } }, total: 17 },
      { payload: { customer: { id: "c2" } }, total: 5 },
    ];
    expect(
      new DocumentFieldMapper().reconstructRows(raw, table.getMetadata(), {
        $groupBy: "customerId",
        $select: ["customerId", { $fn: "sum", $field: "amount", $as: "total" }],
      }),
    ).toEqual([
      { customerId: "c1", total: 17 },
      { customerId: "c2", total: 5 },
    ]);

    const view = await space
      .getView(fx.DvOrderView)
      .findMany({ filter: { customer: "c1" }, controls: { $sort: { id: 1 } } });
    expect(strip(view as never)).toEqual([
      { id: 1, customer: "c1", vip: true },
      { id: 3, customer: "c1", vip: true },
    ]);
  });

  it("the unique index on the source path rejects a duplicate; $inc on the derived field is refused", async () => {
    const table = space.getTable(fx.DvOrder);
    let conflict: unknown;
    try {
      await table.insertOne({
        id: 4,
        status: "x",
        payload: { customer: { id: "c4", vip: false }, total: 1 },
        meta: { region: "eu" },
      } as never);
    } catch (e) {
      conflict = e;
    }
    expect(conflict).toBeInstanceOf(DbError);
    expect((conflict as DbError).code).toBe("CONFLICT");

    let inc: unknown;
    try {
      await table.updateOne({ id: 1, amount: { $inc: 1 } } as never);
    } catch (e) {
      inc = e;
    }
    expect((inc as Error).message).toContain("not allowed on a @db.column.derived field");
    // patching the source leaf moves the derived value
    await table.updateOne({
      id: 1,
      payload: { customer: { id: "c1b", vip: true }, total: 10 },
    } as never);
    expect(
      await table.findOne({ filter: { id: 1 }, controls: { $select: ["customerId"] } }),
    ).toMatchObject({ customerId: "c1b" });
  });

  it("schema sync never adds, unsets or backfills the source leaf", async () => {
    const raw = db.collection("dv_sync");
    const docsBefore = async () => strip(await raw.find({}, { sort: { id: 1 } }).toArray());
    expect((await new SchemaSync(space).run([fx.DvSyncV0], { force: true })).status).toBe("synced");
    await space.getTable(fx.DvSyncV0).insertMany([
      { id: 1, payload: { customer: { id: "a", n: 1 }, code: "A" } },
      { id: 2, payload: { customer: { id: "b", n: 2 } } },
    ] as never);
    const snapshot = await docsBefore();

    const added = await new SchemaSync(space).run([fx.DvSyncV1]);
    expect(added.status).toBe("synced");
    const entry = added.entries.find((e) => e.name === "dv_sync")!;
    expect(entry.columnsAdded).toEqual([]);
    expect(entry.errors).toEqual([]);
    expect(await docsBefore()).toEqual(snapshot);
    expect(await indexKeys(raw)).toContain(JSON.stringify({ "payload.customer.id": 1 }));
    expect((await new SchemaSync(space).run([fx.DvSyncV1])).status).toBe("up-to-date");
    expect(
      (
        await space.getTable(fx.DvSyncV1).findMany({ filter: {}, controls: { $sort: { id: 1 } } })
      ).map((r: any) => r.customerId),
    ).toEqual(["a", "b"]);

    // Expression change moves the index, docs untouched
    await new SchemaSync(space).run([fx.DvSyncV2]);
    expect(await docsBefore()).toEqual(snapshot);
    expect(await indexKeys(raw)).toContain(JSON.stringify({ "payload.code": 1 }));
    expect(await indexKeys(raw)).not.toContain(JSON.stringify({ "payload.customer.id": 1 }));

    // Removal: no $unset of the source
    const removed = await new SchemaSync(space).run([fx.DvSyncV0]);
    expect(removed.entries.find((e) => e.name === "dv_sync")!.columnsDropped).toEqual([]);
    expect(await docsBefore()).toEqual(snapshot);
    expect((await new SchemaSync(space).run([fx.DvSyncV0])).status).toBe("up-to-date");
  });
});
