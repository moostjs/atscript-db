import { AtscriptDbTable, DbError, DbSpace } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

let VersionedUserTable: any;

/**
 * `touchMany` on Mongo (since 0.1.129): `updateMany({ $or }, { $inc: { version: 1 } })`
 * per chunk. The memory server is a standalone topology, so `withTransaction`
 * is a passthrough — the pre-count is what protects the stale case here.
 */
describe("touchMany via MongoAdapter + AtscriptDbTable", () => {
  let server: any;
  let client: MongoClient;
  let db: Db;
  let users: AtscriptDbTable;
  let usersAdapter: MongoAdapter;

  beforeAll(async () => {
    await prepareFixtures();
    VersionedUserTable = (await import("./fixtures/version-occ.as")).VersionedUserTable;

    const { MongoMemoryServer } = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server = await MongoMemoryServer.create();
    client = new MC(server.getUri());
    await client.connect();
    db = client.db("test");
    const space = new DbSpace(() => new MongoAdapter(db, client));
    users = space.getTable(VersionedUserTable);
    usersAdapter = space.getAdapter(VersionedUserTable) as unknown as MongoAdapter;
  }, 60000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  beforeEach(async () => {
    try {
      await db.collection("versioned_users").drop();
    } catch {
      /* not yet created */
    }
    usersAdapter.clearCollectionCache();
    await users.insertMany([
      { id: 1, name: "Ada", status: "active", counter: 0 },
      { id: 2, name: "Bob", status: "active", counter: 0 },
      { id: 3, name: "Cy", status: "active", counter: 0 },
    ] as any);
    await users.updateOne({ id: 3, counter: 1 } as any); // version 1
  });

  const versions = async () =>
    ((await users.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[]).map(
      (r) => r.version,
    );

  it("full match bumps every version by exactly 1 and reports { m, m }", async () => {
    const result = await users.touchMany([
      { id: 1, version: 0 },
      { id: 2, version: 0 },
      { id: 3, version: 1 },
    ] as any);
    expect(result).toEqual({ matchedCount: 3, modifiedCount: 3 });
    expect(await versions()).toEqual([1, 1, 2]);
  });

  it("one stale key → CAS_MISMATCH from the pre-count, no version moves", async () => {
    const err = await users
      .touchMany([
        { id: 1, version: 0 },
        { id: 2, version: 7 },
        { id: 3, version: 1 },
      ] as any)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("CAS_MISMATCH");
    expect((err as DbError).errors[0]).toEqual({
      path: "$cas",
      message: "touchMany: 2 of 3 rows matched — stale or missing rows",
    });
    expect(await versions()).toEqual([0, 0, 1]);
  });

  it("require: 'any' bumps what matches and reports the partial result", async () => {
    const result = await users.touchMany(
      [
        { id: 1, version: 0 },
        { id: 2, version: 7 },
        { id: 3, version: 1 },
      ] as any,
      { require: "any" },
    );
    expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
    expect(await versions()).toEqual([1, 0, 2]);
  });
});
