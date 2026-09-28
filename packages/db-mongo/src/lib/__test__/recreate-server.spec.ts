import { DbSpace } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// `recreateTable` against a real MongoDB (mongodb-memory-server): the new
// collection is built under a temp name and swapped in with one atomic
// rename (since 0.1.138), so a failure leaves the original untouched and no
// `<name>__tmp_<ts>` collection behind.

let server: any;
let client: MongoClient;
let RecreateLog: any;

/** Fresh documents per call — `insertMany` adds `_id` to the objects it gets. */
function docs() {
  return [
    { id: 1, message: "a" },
    { id: 2, message: "b" },
    { id: 3, message: "c" },
  ];
}

beforeAll(async () => {
  await prepareFixtures();
  ({ RecreateLog } = await import("./fixtures/recreate.as"));
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

/** The table's adapter, after its metadata is built (as sync does before a recreate). */
function adapterFor(db: Db): MongoAdapter {
  const table = new DbSpace(() => new MongoAdapter(db, client)).getTable(RecreateLog);
  void table.fieldDescriptors;
  return table.dbAdapter as MongoAdapter;
}

/** A database holding an uncapped `recreate_logs` with {@link docs}. */
async function seeded(name: string): Promise<{ db: Db; adapter: MongoAdapter }> {
  const db = client.db(name);
  await db.collection("recreate_logs").insertMany(docs());
  return { db, adapter: adapterFor(db) };
}

async function collectionNames(db: Db): Promise<string[]> {
  return (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).toSorted();
}

async function messages(db: Db): Promise<string[]> {
  const docs = await db
    .collection("recreate_logs")
    .find({}, { sort: { id: 1 } })
    .toArray();
  return docs.map((d) => d.message as string);
}

describe("MongoAdapter.recreateTable (MongoDB)", () => {
  it("rebuilds the collection with its current options and keeps every document", async () => {
    const { db, adapter } = await seeded("recreate_ok");
    await adapter.recreateTable();
    expect(await collectionNames(db)).toEqual(["recreate_logs"]);
    expect(await messages(db)).toEqual(["a", "b", "c"]);
    expect(await db.collection("recreate_logs").isCapped()).toBe(true);
  });

  it("rebuilds an empty collection", async () => {
    const db = client.db("recreate_empty");
    await db.createCollection("recreate_logs");
    await adapterFor(db).recreateTable();
    expect(await collectionNames(db)).toEqual(["recreate_logs"]);
    expect(await db.collection("recreate_logs").isCapped()).toBe(true);
  });

  it("leaves the original untouched and drops the temp collection when the swap fails", async () => {
    const { db, adapter } = await seeded("recreate_fail");
    const rename = vi.spyOn(db, "renameCollection").mockRejectedValueOnce(new Error("boom"));
    await expect(adapter.recreateTable()).rejects.toThrow("boom");
    rename.mockRestore();
    expect(await collectionNames(db)).toEqual(["recreate_logs"]);
    expect(await messages(db)).toEqual(["a", "b", "c"]);
    expect(await db.collection("recreate_logs").isCapped()).toBe(false);
  });
});
