import { DbError, DbSpace } from "@atscript/db";
import type { MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Locking reads + isolation on MongoDB (since 0.1.162): no row locks
// (`LOCK_NOT_SUPPORTED` — use $cas / withOptimisticRetry); a transaction's
// snapshot satisfies 'read committed' / 'repeatable read', 'serializable' is
// refused, and any level is refused where there is no transaction.

let replSet: any;
let client: MongoClient;
let VersionedUserTable: any;

beforeAll(async () => {
  await prepareFixtures();
  VersionedUserTable = (await import("./fixtures/version-occ.as")).VersionedUserTable;
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

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return error instanceof DbError ? error.code : String(error);
}

describe("MongoAdapter — locking reads and isolation", () => {
  let users: any;
  let adapter: MongoAdapter;

  beforeEach(async () => {
    const db = client.db("read_lock");
    await db.dropDatabase();
    const space = new DbSpace(() => new MongoAdapter(db, client));
    users = space.getTable(VersionedUserTable);
    adapter = users.getAdapter() as MongoAdapter;
    await users.insertOne({ id: 1, name: "Ada", status: "active", counter: 0 });
  });

  it("a locking read throws LOCK_NOT_SUPPORTED (inside a transaction, too)", async () => {
    expect(
      await codeOf(
        adapter.withTransaction(() =>
          users.findOne({ filter: { id: 1 }, controls: {} }, { lock: "update" }),
        ),
      ),
    ).toBe("LOCK_NOT_SUPPORTED");
    expect(await codeOf(users.findById(1, { lock: "share" }))).toBe("LOCK_NOT_SUPPORTED");
  });

  it("'read committed' / 'repeatable read' run in a real transaction; nested requests join", async () => {
    for (const isolation of ["read committed", "repeatable read"] as const) {
      const inTx = await adapter.withTransaction(
        () =>
          adapter.withTransaction(async () => adapter.isInTransaction(), {
            isolation: "repeatable read",
          }),
        { isolation },
      );
      expect(inTx).toBe(true);
    }
  });

  it("'serializable' throws ISOLATION_NOT_SUPPORTED", async () => {
    expect(
      await codeOf(adapter.withTransaction(async () => {}, { isolation: "serializable" })),
    ).toBe("ISOLATION_NOT_SUPPORTED");
  });

  it("without transactions (no client) any requested level throws ISOLATION_NOT_SUPPORTED", async () => {
    const space = new DbSpace(() => new MongoAdapter(client.db("read_lock")));
    const plain = space.getTable(VersionedUserTable).getAdapter() as MongoAdapter;
    expect(
      await codeOf(plain.withTransaction(async () => {}, { isolation: "read committed" })),
    ).toBe("ISOLATION_NOT_SUPPORTED");
    await expect(plain.withTransaction(async () => 1)).resolves.toBe(1);
  });
});
