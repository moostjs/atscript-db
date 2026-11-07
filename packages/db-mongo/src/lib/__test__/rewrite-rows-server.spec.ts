import { DbSpace } from "@atscript/db";
import { SchemaSync, planSchema, rewriteRowsStep } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// MongoDB (mongodb-memory-server, a standalone server: no transactions, so
// the step runs in pass-through mode). `rewriteRowsStep` reads the documents in
// `_id` order, a batch at a time (`$gt` on the last `_id`), and writes only the
// documents the map changed (since 0.1.175).

let server: any;
let client: MongoClient;
let db: Db;
let fx: Record<string, any>;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rewrite-rows.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("rewrite_rows");
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  space = new DbSpace(() => new MongoAdapter(db, client));
  await space.getTable(fx.RwChat).ensureTable();
});

const clamp = (turns: string[]) => turns.slice(-2);

describe("MongoAdapter — rewriteRowsStep", () => {
  it("pages by _id with $gt, writes only the changed documents and notes the count", async () => {
    const table = space.getTable(fx.RwChat) as any;
    await table.insertMany(
      [1, 2, 3, 4, 5].map((n) => ({
        title: `t${n}`,
        turns: n % 2 === 1 ? ["a", "b", "c"] : ["a"],
      })),
    );
    const findMany = vi.spyOn(table, "findMany");
    const bulkUpdate = vi.spyOn(table, "bulkUpdate");
    const step = rewriteRowsStep(fx.RwChat, { field: "turns", map: clamp, batchSize: 2 });

    const result = await new SchemaSync(space).run([fx.RwChat], { dataSteps: [step] });

    expect(result.dataSteps?.ran).toEqual([step.id]);
    expect(result.dataSteps?.notes).toEqual({ [step.id]: "rewrote 3 of 5 rows" });
    // 5 documents in batches of 2: three reads, keyed on `_id`
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[0]![0]).toEqual({
      filter: {},
      controls: { $sort: { _id: 1 }, $limit: 2 },
    });
    expect((findMany.mock.calls[1]![0] as any).filter).toEqual({ _id: { $gt: expect.anything() } });
    expect((findMany.mock.calls[2]![0] as any).filter).toEqual({ _id: { $gt: expect.anything() } });
    // Only the three long documents were patched, each by its `_id`
    const patches = bulkUpdate.mock.calls.flatMap(([batch]) => batch as any[]);
    expect(patches).toHaveLength(3);
    expect(patches.every((p) => p._id !== undefined && Object.keys(p).length === 2)).toBe(true);

    const rows = await table.findMany({ controls: { $sort: { _id: 1 } } });
    expect(rows.map((r: any) => r.turns)).toEqual([
      ["b", "c"],
      ["a"],
      ["b", "c"],
      ["a"],
      ["b", "c"],
    ]);
    expect(rows.map((r: any) => r.title)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    // Recorded: nothing left to run
    expect((await planSchema(space, [fx.RwChat], { dataSteps: [step] })).pendingDataSteps).toEqual(
      [],
    );
  });

  it("refuses _id as the field (the implicit key is caught when the step runs)", async () => {
    const table = space.getTable(fx.RwChat) as any;
    await table.insertOne({ title: "t", turns: ["a"] });
    const step = rewriteRowsStep(fx.RwChat, { field: "_id", map: (v) => v });
    await expect(new SchemaSync(space).run([fx.RwChat], { dataSteps: [step] })).rejects.toThrow(
      /"rw_chats._id" is a primary-key field/,
    );
  });
});
