import { DbSpace } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Application-level cascades (MongoDB has no native foreign keys) with a
// relational-predicate delete filter / scope (mongodb-memory-server), since
// 0.1.147: the parents matching the filter are pinned BEFORE their children are
// cascaded / nulled, so the delete itself never re-evaluates the predicate on
// the changed data (which used to keep the parent and lose its children).

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;
let projectIds: string[] = [];

const T = (name: string) => space.getTable(fx[name]) as any;
const all = async (name: string, key = "id") =>
  ((await T(name).findMany({ filter: {}, controls: { $sort: { [key]: 1 } } })) as any[]).map(
    (r) => r[key],
  );
const notes = async () =>
  ((await T("RdNote").findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[]).map(
    (r) => [r.id, r.ticketKey ?? null],
  );

async function seed() {
  await db.dropDatabase();
  space = new DbSpace(() => new MongoAdapter(db, client));
  await T("RdTicket").insertMany([
    { key: "K1", status: "open" },
    { key: "K2", status: "open" },
    { key: "K3", status: "closed" },
  ]);
  await T("RdIssue").insertMany([
    { id: 1, ticketKey: "K1", title: "crash" },
    { id: 2, ticketKey: "K1", title: "mine" },
    { id: 3, ticketKey: "K2", title: "other" },
    { id: 4, ticketKey: "K3", title: "crash" },
  ]);
  await T("RdNote").insertMany([
    { id: 1, ticketKey: "K1" },
    { id: 2, ticketKey: "K2" },
    { id: 3, ticketKey: "K3" },
  ]);
  projectIds = [];
  for (const name of ["p1", "p2"]) {
    const { insertedId } = await T("RdProject").insertOne({ name });
    projectIds.push(insertedId as string);
  }
  await T("RdTask").insertMany([
    { id: 1, projectId: projectIds[0], title: "urgent" },
    { id: 2, projectId: projectIds[0], title: "later" },
    { id: 3, projectId: projectIds[1], title: "later" },
  ]);
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rel-filter-cascade.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("rel_filter_cascade");
}, 60_000);

beforeEach(seed);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

describe("MongoDB app-level cascades with a predicate filter / scope", () => {
  it("deleteMany: the matched parents go, their children cascade / are nulled", async () => {
    expect(await T("RdTicket").deleteMany({ issues: { $some: { title: "crash" } } })).toEqual({
      deletedCount: 2,
    });
    expect(await all("RdTicket", "key")).toEqual(["K2"]);
    expect(await all("RdIssue")).toEqual([3]);
    expect(await notes()).toEqual([
      [1, null],
      [2, "K2"],
      [3, null],
    ]);
  });

  it("deleteMany over a setNull relation's predicate", async () => {
    expect(await T("RdTicket").deleteMany({ status: "open", notes: { $some: {} } })).toEqual({
      deletedCount: 2,
    });
    expect(await all("RdTicket", "key")).toEqual(["K3"]);
    expect(await all("RdIssue")).toEqual([4]);
    expect(await notes()).toEqual([
      [1, null],
      [2, null],
      [3, "K3"],
    ]);
  });

  it("deleteOne with a predicate scope: in scope → deleted with its children", async () => {
    const scope = { issues: { $some: { title: "mine" } } };
    expect(await T("RdTicket").deleteOne("K1", { scope })).toEqual({ deletedCount: 1 });
    expect(await all("RdTicket", "key")).toEqual(["K2", "K3"]);
    expect(await all("RdIssue")).toEqual([3, 4]);
    expect(await notes()).toEqual([
      [1, null],
      [2, "K2"],
      [3, "K3"],
    ]);
  });

  it("deleteOne with a predicate scope: out of scope → 0, nothing touched", async () => {
    const scope = { issues: { $some: { title: "mine" } } };
    expect(await T("RdTicket").deleteOne("K2", { scope })).toEqual({ deletedCount: 0 });
    expect(await all("RdTicket", "key")).toEqual(["K1", "K2", "K3"]);
    expect(await all("RdIssue")).toEqual([1, 2, 3, 4]);
    expect(await notes()).toEqual([
      [1, "K1"],
      [2, "K2"],
      [3, "K3"],
    ]);
  });

  it("ObjectId primary key: deleteMany and a scoped deleteOne", async () => {
    expect(
      await T("RdProject").deleteOne(projectIds[1], {
        scope: { tasks: { $some: { title: "urgent" } } },
      }),
    ).toEqual({ deletedCount: 0 });
    expect(await all("RdTask")).toEqual([1, 2, 3]);
    expect(await T("RdProject").deleteMany({ tasks: { $some: { title: "urgent" } } })).toEqual({
      deletedCount: 1,
    });
    expect(await all("RdProject", "name")).toEqual(["p2"]);
    expect(await all("RdTask")).toEqual([3]);
    expect(
      await T("RdProject").deleteOne(projectIds[1], { scope: { tasks: { $some: {} } } }),
    ).toEqual({ deletedCount: 1 });
    expect(await all("RdProject", "name")).toEqual([]);
    expect(await all("RdTask")).toEqual([]);
  });
});
