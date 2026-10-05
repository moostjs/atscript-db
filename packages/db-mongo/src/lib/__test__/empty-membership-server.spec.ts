import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Empty membership against a real MongoDB (mongodb-memory-server): `$in: []`
// matches nothing and `$nin: []` matches EVERY row — a null and a missing
// `code` included.

let server: any;
let client: MongoClient;
let space: DbSpace;
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/insert-ignore.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  const db = client.db("empty_membership");
  space = new DbSpace(() => new MongoAdapter(db, client));
  await new SchemaSync(space).run([fx.IgItem], { force: true });
  await (space.getTable(fx.IgItem) as any).insertMany([
    { id: 1, sku: "a", pairA: "x", qty: 1 },
    { id: 2, sku: "b", qty: 1 },
    { id: 3, sku: "c", pairA: null, qty: 1 },
  ]);
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

const ids = async (filter: Record<string, unknown>) =>
  (
    (await (space.getTable(fx.IgItem) as any).findMany({
      filter,
      controls: { $sort: { id: 1 } },
    })) as any[]
  ).map((r) => r.id);

describe("MongoDB empty membership", () => {
  it("$in: [] matches nothing", async () => {
    expect(await ids({ pairA: { $in: [] } })).toEqual([]);
    expect(await ids({ sku: { $in: [] } })).toEqual([]);
  });

  it("$nin: [] matches every row, null and missing included", async () => {
    expect(await ids({ pairA: { $nin: [] } })).toEqual([1, 2, 3]);
  });

  it("composes with other clauses and negation", async () => {
    expect(await ids({ pairA: { $in: [] }, sku: "a" })).toEqual([]);
    expect(await ids({ pairA: { $nin: [] }, sku: "b" })).toEqual([2]);
    expect(await ids({ $not: { pairA: { $in: [] } } })).toEqual([1, 2, 3]);
  });
});
