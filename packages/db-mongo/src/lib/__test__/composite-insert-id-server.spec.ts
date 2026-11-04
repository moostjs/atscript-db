import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Since 0.1.169 an insert into a composite-primary-key collection (no explicit
// `_id`) reports the primary-key object keyed by logical field names — before,
// the driver's `_id`. Against mongodb-memory-server.

let fx: Record<string, any>;
let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let pairs: any;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/composite-insert-id.as");
  const core = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await core.MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
}, 120_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

beforeEach(async () => {
  db = client.db("cid");
  await db.dropDatabase();
  space = new DbSpace(() => new MongoAdapter(db, client));
  const result = await new SchemaSync(space).run([fx.CidPair, fx.CidSingle, fx.CidSeq], {
    force: true,
  });
  expect(result.status).toBe("synced");
  pairs = space.getTable(fx.CidPair);
});

describe("[mongo] composite primary key — insertedId", () => {
  it("insertOne reports the primary-key object by logical field names", async () => {
    const result = await pairs.insertOne({ left: 1, right: "a", label: "A" });
    expect(result).toEqual({ insertedId: { left: 1, right: "a" } });
    expect(await pairs.findById(result.insertedId)).toMatchObject({ left: 1, right: "a" });
  });

  it("insertMany and onConflict: ignore report one primary-key object per inserted row", async () => {
    expect(
      await pairs.insertMany([
        { left: 1, right: "a", label: "A" },
        { left: 1, right: "b", label: "B" },
      ]),
    ).toEqual({
      insertedCount: 2,
      insertedIds: [
        { left: 1, right: "a" },
        { left: 1, right: "b" },
      ],
    });
    expect(
      await pairs.insertMany(
        [
          { left: 1, right: "a", label: "dup" },
          { left: 2, right: "c", label: "C" },
        ],
        { onConflict: "ignore" },
      ),
    ).toEqual({
      insertedCount: 1,
      insertedIds: [{ left: 2, right: "c" }],
      inserted: [1],
      conflicts: [0],
    });
  });

  it("insertOne({ returning: true }) reads back the inserted row", async () => {
    await pairs.insertOne({ left: 10, right: "a", code: 2, label: "first" });
    const result = await pairs.insertOne(
      { left: 20, right: "b", code: 1, label: "second" },
      { returning: true },
    );
    expect(result.insertedId).toEqual({ left: 20, right: "b" });
    expect(result.row).toMatchObject({ left: 20, right: "b", label: "second" });
  });

  it("a key part from the increment counter is part of the id", async () => {
    const seq = space.getTable(fx.CidSeq) as any;
    expect(await seq.insertOne({ tenant: "t1", label: "x" })).toEqual({
      insertedId: { tenant: "t1", seq: 1 },
    });
    expect((await seq.insertMany([{ tenant: "t1", label: "y" }])).insertedIds).toEqual([
      { tenant: "t1", seq: 2 },
    ]);
  });

  it("a single primary key keeps its scalar id", async () => {
    const single = space.getTable(fx.CidSingle) as any;
    expect(await single.insertOne({ label: "a" })).toEqual({ insertedId: 1 });
    expect((await single.insertMany([{ label: "b" }])).insertedIds).toEqual([2]);
  });
});
