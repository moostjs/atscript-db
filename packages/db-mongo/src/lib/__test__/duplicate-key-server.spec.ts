import { DbError, DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// A unique-index violation is a `DbError("CONFLICT")` on EVERY write path
// (mongodb-memory-server): insert and replace always mapped E11000, patch /
// update / updateMany / replaceMany used to let the raw `MongoServerError`
// escape (a 500 over HTTP instead of the 409 the other adapters answer).

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;

const ROWS = [
  { id: 1, email: "a@x.io", handle: "a", payload: { ref: "R1" } },
  { id: 2, email: "b@x.io", handle: "b", payload: { ref: "R2" } },
  { id: 3, email: "c@x.io", handle: "c", payload: { ref: "R3" } },
];

async function conflictOf(fn: () => Promise<unknown>): Promise<DbError> {
  let error: unknown;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe("CONFLICT");
  return error as DbError;
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/dup-key.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("dup_key");
  space = new DbSpace(() => new MongoAdapter(db, client));
  const result = await new SchemaSync(space).run([fx.DkUser], { force: true });
  expect(result.status).toBe("synced");
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

beforeEach(async () => {
  await db.collection("dk_users").deleteMany({});
  await space.getTable(fx.DkUser).insertMany(structuredClone(ROWS) as never);
});

const table = () => space.getTable(fx.DkUser);
const rowsUnchanged = async () => {
  const rows = await table().findMany({ filter: {}, controls: { $sort: { id: 1 } } });
  expect(rows.map((r: any) => [r.id, r.email, r.handle, r.ref])).toEqual(
    ROWS.map((r) => [r.id, r.email, r.handle, r.payload.ref]),
  );
};

describe("MongoDB: duplicate keys are CONFLICT on every write path", () => {
  it("insertOne / insertMany (baseline)", async () => {
    await conflictOf(() => table().insertOne({ id: 9, email: "a@x.io" } as never));
    await conflictOf(() => table().insertMany([{ id: 9, email: "n@x.io", handle: "b" }] as never));
    await rowsUnchanged();
  });

  it("updateOne (native patch) — plain unique field, and a unique derived column", async () => {
    const plain = await conflictOf(() => table().updateOne({ id: 1, email: "b@x.io" } as never));
    expect(plain.errors[0]?.path).toBe("email");
    const derived = await conflictOf(() =>
      table().updateOne({ id: 1, payload: { ref: "R3" } } as never),
    );
    expect(derived.errors[0]?.path).toBe("payload.ref");
    await rowsUnchanged();
  });

  it("bulkUpdate", async () => {
    await conflictOf(() =>
      table().bulkUpdate([
        { id: 1, handle: "a1" },
        { id: 2, handle: "c" },
      ] as never),
    );
  });

  it("replaceOne / bulkReplace", async () => {
    await conflictOf(() => table().replaceOne({ id: 1, email: "c@x.io", handle: "a" } as never));
    await conflictOf(() => table().bulkReplace([{ id: 2, email: "a@x.io", handle: "b" }] as never));
    await rowsUnchanged();
  });

  it("updateMany", async () => {
    // (Mongo applies updateMany per document — the rows before the duplicate
    // stay updated; only the error mapping is under test here.)
    await conflictOf(() =>
      table().updateMany({ id: { $in: [1, 2] } } as never, { handle: "z" } as never),
    );
  });

  it("replaceMany", async () => {
    await conflictOf(() =>
      table().replaceMany({ id: { $in: [1, 2] } } as never, { email: "same@x.io" } as never),
    );
  });

  it("a non-conflicting write still goes through", async () => {
    expect(await table().updateOne({ id: 1, email: "a2@x.io" } as never)).toMatchObject({
      matchedCount: 1,
      modifiedCount: 1,
    });
    expect(await table().updateMany({ id: 3 } as never, { handle: "c3" } as never)).toMatchObject({
      matchedCount: 1,
    });
  });
});
