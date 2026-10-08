import { DbSpace } from "@atscript/db";
import type { AtscriptDbTable } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

let VxRecord: any;

// `@db.column.version.exempt` (since 0.1.150) on the Mongo adapter: the
// `nativePatch` (updateOne) and `updateMany` paths skip the `$inc` version bump.
describe("MongoAdapter — version-exempt patches", () => {
  let server: any;
  let client: MongoClient;
  let db: Db;
  let table: AtscriptDbTable;
  let adapter: MongoAdapter;

  beforeAll(async () => {
    await prepareFixtures();
    VxRecord = (await import("./fixtures/version-exempt.as")).VxRecord;
    const { MongoMemoryServer } = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server = await MongoMemoryServer.create();
    client = new MC(server.getUri());
    await client.connect();
    db = client.db("test");
    const space = new DbSpace(() => new MongoAdapter(db, client));
    table = space.getTable(VxRecord);
    adapter = space.getAdapter(VxRecord) as unknown as MongoAdapter;
  }, 60000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  beforeEach(async () => {
    try {
      await db.collection("vx_records").drop();
    } catch {
      /* not yet created */
    }
    adapter.clearCollectionCache();
    for (const id of [1, 2, 3]) {
      await table.insertOne({
        id,
        title: `t${id}`,
        status: "open",
        score: 0,
        hits: 0,
        metrics: { impact: 1 },
        stats: { views: 0 },
        mixed: { cached: 0, label: "l" },
        tags: [],
      } as any);
    }
  });

  const read = async (id: number) => (await table.findOne({ filter: { id }, controls: {} })) as any;

  it("exempt-only updateOne keeps the version", async () => {
    const r = await table.updateOne({ id: 1, score: 7 } as any);
    expect(r.matchedCount).toBe(1);
    const row = await read(1);
    expect(row.score).toBe(7);
    expect(row.version).toBe(0);
  });

  it("a mixed patch bumps", async () => {
    await table.updateOne({ id: 1, score: 7, title: "x" } as any);
    expect((await read(1)).version).toBe(1);
  });

  it("$cas + exempt-only checks and bumps; stale $cas misses", async () => {
    await table.updateOne({ id: 1, score: 7, $cas: { version: 0 } } as any);
    expect((await read(1)).version).toBe(1);
    const stale = await table.updateOne({ id: 1, score: 8, $cas: { version: 0 } } as any);
    expect(stale.matchedCount).toBe(0);
    expect((await read(1)).score).toBe(7);
  });

  it("$inc on an exempt column does not bump", async () => {
    await table.updateOne({ id: 1, hits: { $inc: 1 } } as any);
    const row = await read(1);
    expect(row.hits).toBe(1);
    expect(row.version).toBe(0);
  });

  it("nested exempt (whole object, closure, merge child) keep the version", async () => {
    await table.updateOne({ id: 1, metrics: { impact: 5, rank: 1 } } as any);
    await table.updateOne({ id: 1, stats: { views: 2 } } as any);
    await table.updateOne({ id: 1, mixed: { cached: 9 } } as any);
    const row = await read(1);
    expect(row.version).toBe(0);
    expect(row.metrics.impact).toBe(5);
    expect(row.stats.views).toBe(2);
    expect(row.mixed).toEqual({ cached: 9, label: "l" });
  });

  it("a non-exempt merge child bumps", async () => {
    await table.updateOne({ id: 1, mixed: { label: "z" } } as any);
    expect((await read(1)).version).toBe(1);
  });

  it("array op on an exempt array keeps the version", async () => {
    await table.updateOne({ id: 1, tags: { $insert: ["a"] } } as any);
    const row = await read(1);
    expect(row.tags).toEqual(["a"]);
    expect(row.version).toBe(0);
  });

  it("updateMany: exempt-only keeps every version, mixed bumps", async () => {
    await table.updateOne({ id: 2, title: "bump" } as any);
    const r = await table.updateMany({ status: "open" } as any, { score: 1 } as any);
    expect(r.matchedCount).toBe(3);
    expect((await read(1)).version).toBe(0);
    expect((await read(2)).version).toBe(1);
    await table.updateMany({ status: "open" } as any, { title: "z" } as any);
    expect((await read(1)).version).toBe(1);
    expect((await read(2)).version).toBe(2);
  });

  it("bulkUpdate decides per item", async () => {
    await table.bulkUpdate([
      { id: 1, score: 1 },
      { id: 2, title: "x" },
    ] as any);
    expect((await read(1)).version).toBe(0);
    expect((await read(2)).version).toBe(1);
  });

  it("replaceOne and touchMany still bump", async () => {
    await table.replaceOne({
      id: 1,
      title: "r",
      status: "open",
      score: 1,
      hits: 1,
      metrics: { impact: 1 },
      stats: { views: 1 },
      mixed: { cached: 1, label: "l" },
      tags: [],
    } as any);
    expect((await read(1)).version).toBe(1);
    await table.touchMany([{ id: 2, version: 0 }] as any);
    expect((await read(2)).version).toBe(1);
  });

  it("reports modified 0 for an unchanged exempt write (no bump forces a change)", async () => {
    await table.updateOne({ id: 1, score: 4 } as any);
    const again = await table.updateOne({ id: 1, score: 4 } as any);
    expect(again).toEqual({ matchedCount: 1, modifiedCount: 0 });
  });
});
