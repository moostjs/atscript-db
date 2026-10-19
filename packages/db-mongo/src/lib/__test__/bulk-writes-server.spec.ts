import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";
import {
  checkBoundedCascade,
  checkBoundedWrites,
  checkBulkValidation,
  checkCounterUpgrade,
  checkOnUpdateInc,
  type TBulkWriteTables,
} from "./bulk-writes-check";

// MongoDB (mongodb-memory-server): bounded writes are emulated by the core
// (read the first keys in order, then write filter AND keys); a replace
// increments `@db.onUpdate.inc` in its `$replaceWith` pipeline; cascades are
// application-level and pin the keys first (since 0.1.162).

let server: any;
let client: MongoClient;
let db: Db;
let fx: Record<string, any>;
let t: TBulkWriteTables;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/bulk-writes.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("bulk_writes");
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  const space = new DbSpace(() => new MongoAdapter(db, client));
  t = {
    tasks: space.getTable(fx.BwTask),
    owners: space.getTable(fx.BwOwner),
    items: space.getTable(fx.BwItem),
  };
  for (const table of [t.tasks, t.owners, t.items]) {
    await table.ensureTable();
    await table.syncIndexes();
  }
});

describe("MongoAdapter — bounded writes, @db.onUpdate.inc, validated bulk payloads", () => {
  it("@db.onUpdate.inc moves on every write path; touchMany stamps @db.onUpdate.now", () =>
    checkOnUpdateInc(t));
  it("updateMany / replaceMany validate their payload", () => checkBulkValidation(t));
  it("bounded updateMany / deleteMany (core emulation)", () => checkBoundedWrites(t));
  it("a bounded delete with an application-level cascade pins the keys first", () =>
    checkBoundedCascade(t));

  it("a document written before the counter existed counts from 1 on every path", async () => {
    const base = { status: "s", priority: 1, title: "t" };
    await t.tasks.insertMany([1, 2, 3, 4].map((id) => Object.assign({ id }, base)));
    // documents that predate `@db.onUpdate.inc` (MongoDB has no backfill)
    await db.collection("bw_tasks").updateMany({}, { $unset: { rev: "" } });
    await t.tasks.updateOne({ id: 1, title: "a" });
    await t.tasks.bulkUpdate([{ id: 2, title: "b" }]);
    await t.tasks.updateMany({ id: 3 }, { title: "c" });
    await t.tasks.replaceOne({ id: 4, ...base, title: "d" });
    for (const id of [1, 2, 3, 4]) {
      expect((await t.tasks.findById(id)).rev, `id ${id}`).toBe(1);
    }
  });
});

describe("MongoAdapter — @db.onUpdate.inc on an existing collection", () => {
  it("schema sync backfills 0; updates count from there", async () => {
    await db.dropDatabase();
    await checkCounterUpgrade(new DbSpace(() => new MongoAdapter(db, client)), SchemaSync, fx);
  });
});
