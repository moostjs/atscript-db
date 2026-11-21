import { DbSpace } from "@atscript/db";
import type { AtscriptDbTable } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { defineMergeInReplaceCases } from "../../../../db/test-kit/merge-in-replace-cases";
import { prepareFixtures } from "./test-utils";

// A merge-strategy object inside a replaced one keeps the children the patch
// leaves out, against a real MongoDB (mongodb-memory-server): the reference
// the other adapters match since 0.1.183. `updateMany` sends a patch that
// writes a field inside an embedded object as the `updateOne` pipeline (since
// 0.1.183; before, a classic update replaced the outer object of a merge
// object whole, and threw on a merge object stored as `null`).

let server: any;
let client: MongoClient;
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/merge-in-replace.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

let dbSeq = 0;

describe("MongoDB — a merge-strategy object inside a replaced one", () => {
  let items: AtscriptDbTable;

  beforeEach(async () => {
    const db = client.db(`merge_in_replace_${++dbSeq}`);
    const space = new DbSpace(() => new MongoAdapter(db, client));
    await new SchemaSync(space).run([fx.MirItem], { force: true });
    items = space.getTable(fx.MirItem);
  });

  defineMergeInReplaceCases(() => items);

  it.each([
    ["a merge object inside a replaced one", { outer: { inner: { x: "9" } } }, true],
    ["a top-level merge object", { mtop: { c: "x" } }, true],
    ["a field operator inside a merge object", { mm: { n: { $inc: 2 } } }, true],
    ["a top-level field", { label: "x" }, false],
    ["a replaced object without a merge object", { outer: { a: "2" } }, false],
  ])("updateMany with %s: one statement, a pipeline: %s", async (_case, patch, pipeline) => {
    const collection = (items.getAdapter() as unknown as MongoAdapter).collection;
    const updateMany = vi.spyOn(collection, "updateMany");
    await items.insertOne({ id: 1, outer: null, mtop: null, mm: null } as any);
    await items.updateMany({ id: 1 }, patch as any);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(Array.isArray(updateMany.mock.calls[0]![1])).toBe(pipeline);
    vi.restoreAllMocks();
  });

  // Not in the shared cases: SQL computes `NULL + 2` as NULL
  it("updateMany: a field operator inside a merge object stored as null, as updateOne", async () => {
    await items.insertMany([
      { id: 1, mm: null },
      { id: 2, mm: null },
    ] as any);
    await items.updateMany({ id: 1 }, { mm: { n: { $inc: 2 } } } as any);
    await items.updateOne({ id: 2, mm: { n: { $inc: 2 } } } as any);
    const rows = (await items.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];
    expect(rows.map((row) => row.mm)).toEqual([{ n: 2 }, { n: 2 }]);
  });
});
