import { DbError } from "@atscript/db";
import type { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { transactionSupport } from "../mongo-transaction-support";

// Transaction support is read from the server, not the connection mode (since
// 0.1.164): a `directConnection=true` client to a replica-set member runs real
// transactions; a standalone `mongod` runs `fn` without one.

const withDirect = (uri: string) => `${uri}${uri.includes("?") ? "&" : "?"}directConnection=true`;

const fakeClient = (command: () => Promise<unknown>) =>
  ({ db: () => ({ command }) }) as unknown as MongoClient;

/** Documents left after `fn` writes one and throws: 0 = rolled back. */
async function rollbackLeaves(client: MongoClient, dbName: string): Promise<number> {
  const db = client.db(dbName);
  const adapter = new MongoAdapter(db, client);
  const col = db.collection("t");
  await col.deleteMany({});
  await expect(
    adapter.withTransaction(async () => {
      await col.insertOne({ a: 1 }, (adapter as any)._getSessionOpts());
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  return col.countDocuments();
}

const MODES = [
  ["replica set over directConnection=true", "MongoMemoryReplSet", true],
  ["standalone", "MongoMemoryServer", false],
] as const;

describe.each(MODES)("withTransaction — %s", (_label, kind, transactions) => {
  let server: any;
  let uri: string;
  const clients: MongoClient[] = [];

  const connect = async (lazy = false) => {
    const { MongoClient: MC } = await import("mongodb");
    const client = new MC(uri);
    clients.push(client);
    return lazy ? client : client.connect();
  };

  beforeAll(async () => {
    const core = await import("mongodb-memory-server-core");
    server =
      kind === "MongoMemoryServer"
        ? await core.MongoMemoryServer.create()
        : await core.MongoMemoryReplSet.create({
            replSet: { count: 1, storageEngine: "wiredTiger" },
            instanceOpts: [{ launchTimeout: 60_000 }],
          });
    uri = withDirect(server.getUri());
  }, 120_000);

  afterAll(async () => {
    for (const client of clients) await client.close();
    if (server) await server.stop();
  });

  it(transactions ? "rolls back a thrown error" : "passes through: writes stay", async () => {
    expect(await rollbackLeaves(await connect(), "tx_rollback")).toBe(transactions ? 0 : 1);
  });

  it("decides on a client that has not connected yet (lazy connect)", async () => {
    expect(await rollbackLeaves(await connect(true), "tx_lazy")).toBe(transactions ? 0 : 1);
  });

  it(
    transactions ? "accepts isolation 'read committed'" : "refuses an isolation level",
    async () => {
      const client = await connect();
      const adapter = new MongoAdapter(client.db("tx_iso"), client);
      const run = adapter.withTransaction(async () => 1, { isolation: "read committed" });
      if (transactions) {
        await expect(run).resolves.toBe(1);
        return;
      }
      const error = await run.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe("ISOLATION_NOT_SUPPORTED");
      expect((error as DbError).message).toMatch(/standalone mongod/);
    },
  );
});

describe("transactionSupport on an uninitiated --replSet member", () => {
  let server: any;
  let client: MongoClient;

  beforeAll(async () => {
    const { MongoMemoryServer } = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server = await MongoMemoryServer.create({ instance: { replSet: "rs0" } });
    client = new MC(withDirect(server.getUri()));
  }, 120_000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  it("is true before rs.initiate (never cached as standalone)", async () => {
    expect(await transactionSupport(client)).toBe(true);
  });
});

describe("transactionSupport verdict", () => {
  it.each([
    ["a replica-set member", { isWritablePrimary: true, setName: "rs0" }, true],
    ["an uninitiated --replSet member", { isreplicaset: true }, true],
    ["a mongos", { msg: "isdbgrid" }, true],
    ["a standalone mongod", { isWritablePrimary: true }, false],
    ["an empty reply", {}, false],
  ])("%s → %s", async (_label, reply, expected) => {
    expect(await transactionSupport(fakeClient(async () => reply))).toBe(expected);
  });

  it("concurrent first calls share one probe", async () => {
    let calls = 0;
    const client = fakeClient(async () => {
      calls++;
      return { setName: "rs0" };
    });
    const results = await Promise.all([transactionSupport(client), transactionSupport(client)]);
    expect(results).toEqual([true, true]);
    expect(calls).toBe(1);
  });

  it("a failed probe is retried; a success is cached", async () => {
    let calls = 0;
    const replies: Array<() => unknown> = [
      () => {
        throw new Error("server selection timed out");
      },
      () => ({ setName: "rs0" }),
    ];
    const client = fakeClient(async () => replies[calls++]!());
    await expect(transactionSupport(client)).rejects.toThrow("server selection timed out");
    await expect(transactionSupport(client)).resolves.toBe(true);
    expect(await transactionSupport(client)).toBe(true);
    expect(calls).toBe(2);
  });
});
