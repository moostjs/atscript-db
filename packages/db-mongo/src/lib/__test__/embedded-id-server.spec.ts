import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// An embedded document's `@meta.id` is not part of the host's key
// (mongodb-memory-server): the managed `__pk` unique index covers the host's
// own `@meta.id` only, and `number.timestamp.created` is filled on insert.

let server: any;
let client: MongoClient;
let db: Db;
let fx: Record<string, any>;

const PK_INDEX = "atscript__unique___pk";

const line = (lineId: string) => ({ lineId, qty: 1 });

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/embedded-id.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("embedded_meta_id");
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

describe("[mongo] embedded @meta.id", () => {
  it("rebuilds an earlier composite __pk index on the host key; same id conflicts", async () => {
    // What earlier versions created: one __pk index over every @meta.id path.
    await db.createCollection("emb_orders");
    await db
      .collection("emb_orders")
      .createIndex(
        { id: 1, "line.lineId": 1, "lines.lineId": 1 },
        { name: PK_INDEX, unique: true },
      );

    const space = new DbSpace(() => new MongoAdapter(db, client));
    const result = await new SchemaSync(space).run([fx.EmbOrder], { force: true });
    expect(result.status).toBe("synced");
    const indexes = await db.collection("emb_orders").indexes();
    expect(indexes.find((i) => i.name === PK_INDEX)?.key).toEqual({ id: 1 });

    const orders = space.getTable(fx.EmbOrder);
    await orders.insertOne({ id: 1, line: line("a"), lines: [line("x")] } as never);
    await expect(
      orders.insertOne({ id: 1, line: line("b"), lines: [] } as never),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await orders.replaceOne({ id: 1, line: line("c"), lines: [] } as never);
    expect(await orders.findById(1)).toMatchObject({ line: { lineId: "c" } });
    expect(await orders.count()).toBe(1);
  });

  it("fills number.timestamp.created, also inside a present embedded document", async () => {
    const space = new DbSpace(() => new MongoAdapter(db, client));
    const orders = space.getTable(fx.EmbOrder);
    const before = Date.now();
    await orders.insertOne({ id: 2, line: { lineId: "a", qty: 1 }, lines: [], audit: {} } as never);
    await orders.insertOne({ id: 3, line: { lineId: "a", qty: 1 }, lines: [] } as never);
    const two = (await orders.findById(2)) as any;
    expect(two.createdAt).toBeGreaterThanOrEqual(before);
    expect(two.audit.at).toBeGreaterThanOrEqual(before);
    expect(await orders.findById(3)).not.toHaveProperty("audit");
  });

  it("a synced composite key losing a member: the __pk index is rebuilt with the data", async () => {
    const space = new DbSpace(() => new MongoAdapter(db, client));
    expect((await new SchemaSync(space).run([fx.KeyBefore])).status).toBe("synced");
    await space.getTable(fx.KeyBefore).insertMany([
      { id: 1, seq: 1, note: "a" },
      { id: 2, seq: 1, note: "b" },
    ] as never);
    const result = await new SchemaSync(space).run([fx.KeyAfter]);
    expect(result.status).toBe("synced");
    expect(result.entries[0]!.errors ?? []).toEqual([]);
    const indexes = await db.collection("key_shrink").indexes();
    expect(indexes.find((i) => i.name === PK_INDEX)?.key).toEqual({ id: 1 });
    expect(await space.getTable(fx.KeyAfter).count()).toBe(2);
  });

  it("documents sharing the new key refuse the change", async () => {
    await db.collection("key_shrink").drop();
    const space = new DbSpace(() => new MongoAdapter(db, client));
    expect((await new SchemaSync(space).run([fx.KeyBefore], { force: true })).status).toBe(
      "synced",
    );
    await space.getTable(fx.KeyBefore).insertMany([
      { id: 1, seq: 1, note: "a" },
      { id: 1, seq: 2, note: "b" },
    ] as never);
    const refused = await new SchemaSync(space).run([fx.KeyAfter]);
    expect(refused.status).toBe("refused");
    expect(refused.entries[0]!.errors).toEqual([
      'Primary key of "key_shrink" changed (id, seq → id) but 2 rows have a NULL or duplicate (id) — fix or remove them (or migrate manually) and re-run.',
    ]);
  });
});
