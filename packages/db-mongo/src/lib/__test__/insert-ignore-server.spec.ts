import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vite-plus/test";

import { createAdapter } from "../index";
import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Conflict-ignoring insert on MongoDB (since 0.1.148), against mongodb-memory-server:
// standalone (`insertMany` ordered:false, 11000 write errors) and a single-node
// replica set (pre-check + ordered insert inside the transaction).

let fx: Record<string, any>;

const item = (id: number, sku: string, extra: Record<string, unknown> = {}) => ({
  id,
  sku,
  qty: 1,
  ...extra,
});

const MODES = [
  ["standalone", "MongoMemoryServer"],
  ["replica set (transaction path)", "MongoMemoryReplSet"],
] as const;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/insert-ignore.as");
});

describe.each(MODES)("MongoDB insert onConflict: ignore — %s", (_label, kind) => {
  let server: any;
  let client: MongoClient;
  let db: Db;
  let space: DbSpace;

  beforeAll(async () => {
    const core = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server =
      kind === "MongoMemoryServer"
        ? await core.MongoMemoryServer.create()
        : await core.MongoMemoryReplSet.create({
            replSet: { count: 1, storageEngine: "wiredTiger" },
            instanceOpts: [{ launchTimeout: 60_000 }],
          });
    client = new MC(server.getUri());
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  beforeEach(async () => {
    db = client.db(`ig_${kind === "MongoMemoryServer" ? "sa" : "rs"}`);
    await db.dropDatabase();
    space = new DbSpace(() => new MongoAdapter(db, client));
    const result = await new SchemaSync(space).run([fx.IgItem, fx.IgAuto, fx.IgNote], {
      force: true,
    });
    expect(result.status).toBe("synced");
  });

  const items = () => space.getTable(fx.IgItem) as any;
  const ids = async () =>
    ((await items().findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[]).map(
      (r) => r.id,
    );

  it("skips rows colliding with stored rows on the PK and on a unique index", async () => {
    await items().insertMany([item(1, "a"), item(2, "b")]);
    const result = await items().insertMany([item(1, "zz"), item(3, "b"), item(4, "d")], {
      onConflict: "ignore",
    });
    expect(result).toEqual({
      insertedCount: 1,
      insertedIds: [4],
      inserted: [2],
      conflicts: [0, 1],
    });
    expect(await ids()).toEqual([1, 2, 4]);
  });

  it("intra-batch duplicates: the first row wins", async () => {
    const result = await items().insertMany([item(1, "a"), item(2, "a"), item(1, "x")], {
      onConflict: "ignore",
    });
    expect(result.conflicts).toEqual([1, 2]);
    expect(await ids()).toEqual([1]);
  });

  it("composite unique index; NULL components never collide", async () => {
    await items().insertMany([item(1, "a", { pairA: "x", pairB: "y" })]);
    const result = await items().insertMany(
      [
        item(2, "b", { pairA: "x", pairB: "y" }),
        item(3, "c", { pairA: "x" }),
        item(4, "d", { pairA: "x" }),
      ],
      { onConflict: "ignore" },
    );
    expect(result.conflicts).toEqual([0]);
    expect(result.insertedIds).toEqual([3, 4]);
  });

  it("generated ids come back for inserted rows only", async () => {
    const auto = space.getTable(fx.IgAuto) as any;
    await auto.insertOne({ sku: "s1", label: "one" });
    const result = await auto.insertMany(
      [
        { sku: "s1", label: "dup" },
        { sku: "s2", label: "two" },
      ],
      { onConflict: "ignore" },
    );
    expect(result.conflicts).toEqual([0]);
    const stored = await auto.findOne({ filter: { sku: "s2" }, controls: {} });
    expect(result.insertedIds).toEqual([stored.id]);
  });

  it("all-conflict batch inserts nothing; insertOne reports conflict", async () => {
    await items().insertMany([item(1, "a")]);
    const result = await items().insertMany([item(1, "a")], { onConflict: "ignore" });
    expect(result).toEqual({ insertedCount: 0, insertedIds: [], inserted: [], conflicts: [0] });
    expect(await items().insertOne(item(2, "a"), { onConflict: "ignore" })).toEqual({
      conflict: true,
    });
    expect(await items().insertOne(item(3, "c"), { onConflict: "ignore" })).toEqual({
      insertedId: 3,
      conflict: false,
    });
  });

  it("inside an explicit transaction a skipped row never aborts it", async () => {
    await items().insertMany([item(1, "a")]);
    await items().dbAdapter.withTransaction(async () => {
      const result = await items().insertMany([item(2, "a"), item(3, "c")], {
        onConflict: "ignore",
      });
      expect(result.conflicts).toEqual([0]);
      await items().insertOne(item(4, "d"));
    });
    expect(await ids()).toEqual([1, 3, 4]);
  });

  it("the default mode still throws CONFLICT", async () => {
    await items().insertMany([item(1, "a")]);
    await expect(items().insertMany([item(2, "a")])).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("MongoDB DbSpace.close() through createAdapter", () => {
  it("closes the client (idempotent); handles reject with SPACE_CLOSED", async () => {
    const { MongoMemoryReplSet } = await import("mongodb-memory-server-core");
    const server = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
      instanceOpts: [{ launchTimeout: 60_000 }],
    });
    try {
      const own = createAdapter(server.getUri());
      const table = own.getTable(fx.IgItem) as any;
      await table.insertOne(item(1, "a"));
      await own.close();
      await own.close();
      await expect(table.findMany({ filter: {}, controls: {} })).rejects.toMatchObject({
        code: "SPACE_CLOSED",
      });
    } finally {
      await server.stop();
    }
  }, 120_000);
});
