import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Since 0.1.137 the adapter's `viewRenderRevision()` is part of every managed
// view's snapshot. A view synced by 0.1.136 (stored snapshot without the
// revision, pipeline rendered the old way) is detected as changed and
// recreated once — against a real MongoDB (mongodb-memory-server).

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/views.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("view_render_revision");
  space = new DbSpace(() => new MongoAdapter(db, client));
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

describe("MongoDB view render revision", () => {
  it("recreates a view whose stored snapshot predates the revision", async () => {
    const types = [fx.MvStore, fx.MvStoreZips];
    const sync = new SchemaSync(space);
    expect((await sync.run(types, { force: true })).status).toBe("synced");
    await space.getTable(fx.MvStore).insertMany([
      { id: 1, address: { city: "Paris", zip: "75001" }, qty: 7, cap: 5 },
      { id: 3, address: { city: "Lyon", zip: "69001" }, qty: 7 },
    ] as never);

    const store = (sync as unknown as { store: any }).store;
    const stored = await store.readTableSnapshot("mv_store_zips", true);
    expect(stored.renderRevision).toBe("2");

    // Put the view back into its 0.1.136 state: pipeline, snapshot, schema hash
    const { renderRevision: _, ...legacy } = stored;
    await store.writeTableSnapshot("mv_store_zips", legacy);
    await store.writeHash("0.1.136");
    await db.collection("mv_store_zips").drop();
    await db.createCollection("mv_store_zips", {
      viewOn: "mv_stores",
      pipeline: [
        { $match: { $and: [{ zip_code: { $ne: null } }, { $expr: { $gt: ["$qty", "$cap"] } }] } },
        { $project: { _id: 0, id: "$id", zip: { $ifNull: ["$zip_code", null] } } },
      ],
    });

    const plan = await sync.plan(types);
    expect(plan.status).toBe("changes-needed");
    expect(plan.entries.find((e) => e.name === "mv_store_zips")?.status).toBe("alter");

    const result = await sync.run(types);
    expect(result.status).toBe("synced");
    expect(result.entries.find((e) => e.name === "mv_store_zips")?.status).toBe("alter");
    const rows = await space
      .getView(fx.MvStoreZips)
      .findMany({ filter: {}, controls: { $sort: { id: 1 } } } as never);
    expect(rows).toEqual([{ id: 1, zip: "75001" }]);
    expect((await store.readTableSnapshot("mv_store_zips", true)).renderRevision).toBe("2");

    // Nothing left to do afterwards
    expect((await sync.plan(types)).status).toBe("up-to-date");
  });
});
