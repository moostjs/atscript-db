import { randomBytes } from "node:crypto";

import { DbSpace } from "@atscript/db";
import type { MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Mutation filters with relational predicates inside a transaction (single-node
// replica set), since 0.1.147: the `_id` resolution and the writes share the
// transaction's session, so a rollback undoes the whole write.

let replSet: any;
let client: MongoClient;
let space: DbSpace;
let fx: Record<string, any>;

const T = (name: string) => space.getTable(fx[name]) as any;
const titles = async () =>
  ((await T("RfIssue").findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[]).map(
    (r) => r.title,
  );

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rel-filter.as");
  const { MongoMemoryReplSet } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
    instanceOpts: [{ launchTimeout: 60_000 }],
  });
  client = new MC(replSet.getUri());
  await client.connect();
}, 120_000);

afterAll(async () => {
  if (client) await client.close();
  if (replSet) await replSet.stop();
});

beforeEach(async () => {
  const db = client.db("rel_filter_tx");
  await db.dropDatabase();
  const encryption = { defaultKeyId: "k1", keys: { k1: randomBytes(32) } };
  space = new DbSpace(() => new MongoAdapter(db, client), { encryption });
  await T("RfTicket").insertOne({ key: "K1", status: "open" });
  await T("RfTicket").insertOne({ key: "K2", status: "closed" });
  // Collections must exist before a transaction writes to them.
  await T("RfIssue").insertMany([
    { id: 1, title: "a", ticketKey: "K1" },
    { id: 2, title: "b", ticketKey: "K2" },
    { id: 3, title: "c" },
  ]);
});

describe("MongoDB relational predicates — writes in a transaction", () => {
  it("resolution and writes run in the transaction's session; a rollback undoes them", async () => {
    const adapter = T("RfIssue").getAdapter() as MongoAdapter;
    const aggregate = vi.spyOn(adapter.collection, "aggregate");
    await expect(
      adapter.withTransaction(async () => {
        const result = await T("RfIssue").updateMany(
          { ticket: { $some: { status: "open" } } },
          { title: "changed" },
        );
        expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
        expect(await T("RfIssue").deleteMany({ ticket: { $none: {} } })).toEqual({
          deletedCount: 1,
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(aggregate).toHaveBeenCalled();
    for (const call of aggregate.mock.calls) {
      expect((call[1] as { session?: unknown }).session).toBeDefined();
    }
    aggregate.mockRestore();
    expect(await titles()).toEqual(["a", "b", "c"]);
  });

  it("commits", async () => {
    const adapter = T("RfIssue").getAdapter() as MongoAdapter;
    await adapter.withTransaction(() =>
      T("RfIssue").updateMany({ ticket: { $some: { status: "closed" } } }, { title: "changed" }),
    );
    expect(await titles()).toEqual(["a", "changed", "c"]);
  });
});
