import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vite-plus/test";

import { ObjectId } from "mongodb";
import type { Db, MongoClient } from "mongodb";
import type { TDbFieldMeta } from "@atscript/db";
import { DbSpace } from "@atscript/db";
import { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

const HEX_A = "665f1e2a9b3c4d5e6f708192";
const HEX_B = "665f1e2a9b3c4d5e6f708193";
const HEX_C = "665f1e2a9b3c4d5e6f708194";

describe("[mongo] objectId storage mapping (formatValue)", () => {
  const mongo = createTestSpace();
  let table: any;
  let adapter: MongoAdapter;

  beforeAll(async () => {
    await prepareFixtures();
    const { OidThing } = await import("./fixtures/objectid-collection.as");
    table = mongo.getTable(OidThing);
    adapter = mongo.getAdapter(OidThing) as unknown as MongoAdapter;
    table.getMetadata();
  });

  function fd(path: string): TDbFieldMeta {
    const found = table.fieldDescriptors.find((f: TDbFieldMeta) => f.path === path);
    expect(found, `field descriptor for "${path}"`).toBeDefined();
    return found!;
  }

  it("registers to/from formatters for top-level objectId fields, including arrays", () => {
    expect(adapter.formatValue(fd("_id"))).toBeDefined();
    expect(adapter.formatValue(fd("ownerId"))).toBeDefined();
    expect(adapter.formatValue(fd("tagIds"))).toBeDefined();
    expect(adapter.formatValue(fd("name"))).toBeUndefined();
  });

  it("does not register formatters for nested objectId fields (writes/reads skip nested paths)", () => {
    expect(adapter.formatValue(fd("nested.innerRef"))).toBeUndefined();
  });

  it("toStorage converts 24-hex strings to ObjectId and passes everything else through", () => {
    const pair = adapter.formatValue(fd("ownerId"))!;
    const converted = pair.toStorage(HEX_A);
    expect(converted).toBeInstanceOf(ObjectId);
    expect((converted as ObjectId).toHexString()).toBe(HEX_A);

    const instance = new ObjectId(HEX_A);
    expect(pair.toStorage(instance)).toBe(instance);
    expect(pair.toStorage("not-a-hex-id")).toBe("not-a-hex-id");
    expect(pair.toStorage(42)).toBe(42);
  });

  it("fromStorage converts ObjectId values (and arrays) back to hex strings", () => {
    const pair = adapter.formatValue(fd("tagIds"))!;
    expect(pair.fromStorage!(new ObjectId(HEX_A))).toBe(HEX_A);
    expect(pair.fromStorage!([new ObjectId(HEX_A), new ObjectId(HEX_B)])).toEqual([HEX_A, HEX_B]);
    expect(pair.fromStorage!(HEX_A)).toBe(HEX_A);
  });
});

describe("[mongo] objectId hex/native round-trip end-to-end", () => {
  let server: any;
  let client: MongoClient;
  let db: Db;
  let table: any;
  let adapter: MongoAdapter;

  beforeAll(async () => {
    await prepareFixtures();
    const { OidThing } = await import("./fixtures/objectid-collection.as");
    const { MongoMemoryServer } = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server = await MongoMemoryServer.create();
    client = new MC(server.getUri());
    await client.connect();
    db = client.db("test");
    const space = new DbSpace(() => new MongoAdapter(db, client));
    table = space.getTable(OidThing);
    adapter = space.getAdapter(OidThing) as unknown as MongoAdapter;
  }, 60000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  beforeEach(async () => {
    try {
      await db.collection("oid-things").drop();
    } catch {
      /* not yet created */
    }
    adapter.clearCollectionCache();
  });

  it("stores hex ids as native ObjectId and returns hex insertedIds", async () => {
    const result = await table.insertOne({
      _id: HEX_A,
      ownerId: HEX_B,
      tagIds: [HEX_C],
      name: "explicit",
    });
    expect(result.insertedId).toBe(HEX_A);

    const raw = await db.collection("oid-things").findOne({});
    expect(raw!._id).toBeInstanceOf(ObjectId);
    expect((raw!._id as ObjectId).toHexString()).toBe(HEX_A);
    expect(raw!.ownerId).toBeInstanceOf(ObjectId);
    expect(raw!.tagIds[0]).toBeInstanceOf(ObjectId);
  });

  it("returns hex insertedIds for driver-generated ids and resolves them via findById", async () => {
    const result = await table.insertOne({ ownerId: HEX_B, name: "generated" });
    expect(typeof result.insertedId).toBe("string");
    expect(result.insertedId).toMatch(/^[a-f0-9]{24}$/);

    const row = await table.findById(result.insertedId);
    expect(row).not.toBeNull();
    expect(row.name).toBe("generated");
  });

  it("matches a verbatim hex id-envelope filter (the @DbAction loadRow 404 bug)", async () => {
    const { insertedId } = await table.insertOne({ ownerId: HEX_B, name: "target" });
    // loadRow passes the wire envelope { _id: '<hex>' } straight to findOne.
    const row = await table.findOne({ filter: { _id: insertedId }, controls: {} });
    expect(row).not.toBeNull();
    expect(row._id).toBe(insertedId);
    expect(row.name).toBe("target");
  });

  it("matches $or-of-envelopes (the loadRows bulk shape)", async () => {
    const a = await table.insertOne({ ownerId: HEX_B, name: "a" });
    const b = await table.insertOne({ ownerId: HEX_B, name: "b" });
    const rows = await table.findMany({
      filter: { $or: [{ _id: a.insertedId }, { _id: b.insertedId }] },
      controls: {},
    });
    expect(rows.map((r: any) => r.name).toSorted()).toEqual(["a", "b"]);
  });

  it("matches hex filters on FK columns — equality and $in (HTTP grid/card filters)", async () => {
    await table.insertOne({ ownerId: HEX_B, name: "mine" });
    await table.insertOne({ ownerId: HEX_C, name: "other" });

    const eq = await table.findMany({ filter: { ownerId: HEX_B }, controls: {} });
    expect(eq.map((r: any) => r.name)).toEqual(["mine"]);

    const inOp = await table.findMany({ filter: { ownerId: { $in: [HEX_C] } }, controls: {} });
    expect(inOp.map((r: any) => r.name)).toEqual(["other"]);
  });

  it("matches rows written by the raw driver with native ObjectIds (pipeline-written data)", async () => {
    await db.collection("oid-things").insertOne({
      _id: new ObjectId(HEX_A),
      ownerId: new ObjectId(HEX_B),
      tagIds: [new ObjectId(HEX_C)],
      name: "raw",
    });

    const row = await table.findOne({ filter: { _id: HEX_A }, controls: {} });
    expect(row).not.toBeNull();
    expect(row._id).toBe(HEX_A);
    expect(row.ownerId).toBe(HEX_B);
    expect(row.tagIds).toEqual([HEX_C]);
  });

  it("keeps the prepareId path intact — findById with a hex string still resolves", async () => {
    await table.insertOne({ _id: HEX_C, ownerId: HEX_B, name: "byid" });
    const row = await table.findById(HEX_C);
    expect(row).not.toBeNull();
    expect(row._id).toBe(HEX_C);
  });
});
