import { randomBytes } from "node:crypto";

import { DbSpace, ResolvedRelationFilter } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { mongoFilterStages } from "../mongo-filter";
import { prepareFixtures } from "./test-utils";

// Relational filter predicates ($some / $none) and native `$with` loading on
// MongoDB (mongodb-memory-server), since 0.1.147:
// - predicates run as correlated `$lookup`s on every read path and on writes
//   (matching `_id`s resolved first, then written by `_id`);
// - a NULL / missing foreign key never relates;
// - `@db.rel.filter` is part of the relation (`$with` and predicates);
// - `$with` lookups address PHYSICAL names (`@db.column` renames) and return
//   logical rows.

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;
const projectIds: string[] = [];
const encryption = { defaultKeyId: "k1", keys: { k1: randomBytes(32) } };

const T = (name: string) => space.getTable(fx[name]) as any;
const ids = (rows: Array<Record<string, unknown>>, key = "id") =>
  rows.map((r) => r[key]).toSorted((a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0));

async function seed() {
  await db.dropDatabase();
  space = new DbSpace(() => new MongoAdapter(db, client), { encryption });
  await T("RfTeam").insertMany([
    { id: "t1", name: "Core" },
    { id: "t2", name: "Web" },
    { id: "t3", name: "Ops" },
  ]);
  // Inserted one by one: `parentKey` references an earlier ticket.
  for (const ticket of [
    { key: "K1", teamId: "t1", status: "open", note: "secret K1" },
    { key: "K2", teamId: "t1", status: "closed", parentKey: "K1" },
    { key: "K3", teamId: "t2", status: "open", parentKey: "K2" },
    { key: "K4", teamId: null, status: "open" },
    { key: "K5", teamId: "t3", status: "closed" },
  ]) {
    await T("RfTicket").insertOne(ticket);
  }
  await T("RfIssue").insertMany([
    { id: 1, title: "crash on start", ticketKey: "K1", location: [2.35, 48.85] },
    { id: 2, title: "typo", ticketKey: "K2", location: [2.36, 48.86] },
    { id: 3, title: "crash in web", ticketKey: "K3", location: [2.4, 48.9] },
    { id: 4, title: "orphan", ticketKey: null },
    { id: 5, title: "no ticket field" },
    { id: 6, title: "ops", ticketKey: "K5" },
  ]);
  await T("RfLabel").insertMany([
    { id: 1, name: "bug" },
    { id: 2, name: "feature" },
    { id: 3, name: "hidden" },
  ]);
  await T("RfTicketLabel").insertMany([
    { id: 1, ticketKey: "K1", labelId: 1, pinned: true },
    { id: 2, ticketKey: "K1", labelId: 3, pinned: true },
    { id: 3, ticketKey: "K2", labelId: 2, pinned: false },
    { id: 4, ticketKey: "K3", labelId: 1, pinned: false },
  ]);
  await T("RfBoard").insertMany([
    { org: "acme", code: "A", title: "Alpha" },
    { org: "acme", code: "B", title: "Beta" },
  ]);
  await T("RfCard").insertMany([
    { id: 1, boardOrg: "acme", boardCode: "A" },
    { id: 2, boardOrg: "acme", boardCode: "B" },
    { id: 3, boardOrg: "acme", boardCode: null },
    { id: 4 },
  ]);
  projectIds.length = 0;
  for (const name of ["proj1", "proj2"]) {
    const { insertedId } = await T("RfProject").insertOne({ name });
    projectIds.push(insertedId as string);
  }
  await T("RfTask").insertMany([
    { id: 1, projectId: projectIds[0], done: false },
    { id: 2, projectId: projectIds[0], done: true },
    { id: 3, done: false },
  ]);
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rel-filter.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("rel_filter");
  await seed();
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

const issues = (filter: Record<string, unknown>, controls: Record<string, unknown> = {}) =>
  T("RfIssue").findMany({ filter, controls });
const tickets = (filter: Record<string, unknown>, controls: Record<string, unknown> = {}) =>
  T("RfTicket").findMany({ filter, controls });

describe("MongoDB relational predicates — reads", () => {
  it("stores the renamed foreign keys physically", async () => {
    expect(await db.collection("rf_issues").findOne({ id: 1 })).toMatchObject({
      ticket_ref: "K1",
    });
    expect(await db.collection("rf_tickets").findOne({ key: "K1" })).toMatchObject({
      team_ref: "t1",
    });
  });

  it("to: $some with $in + eq (renamed FK on the source)", async () => {
    const rows = await issues({
      ticket: { $some: { teamId: { $in: ["t1", "t2"] }, status: "open" } },
    });
    expect(ids(rows)).toEqual([1, 3]);
  });

  it("to: $none includes NULL and missing foreign keys", async () => {
    expect(ids(await issues({ ticket: { $none: { status: "open" } } }))).toEqual([2, 4, 5, 6]);
  });

  it("$some: {} / $none: {} — has / has no related row", async () => {
    expect(ids(await issues({ ticket: { $some: {} } }))).toEqual([1, 2, 3, 6]);
    expect(ids(await issues({ ticket: { $none: {} } }))).toEqual([4, 5]);
  });

  it("a NULL / missing foreign key never relates — not even to a keyless target document", async () => {
    const raw = db.collection("rf_tickets");
    await raw.insertMany([{ status: "open" }, { key: null, status: "open" } as never]);
    try {
      expect(ids(await issues({ ticket: { $some: {} } }))).toEqual([1, 2, 3, 6]);
      expect(ids(await issues({ ticket: { $none: {} } }))).toEqual([4, 5]);
    } finally {
      await raw.deleteMany({ key: { $in: [null] } });
    }
  });

  it("from: $some / $none (renamed FK on the target)", async () => {
    expect(
      ids(await tickets({ issues: { $some: { title: { $regex: "crash" } } } }), "key"),
    ).toEqual(["K1", "K3"]);
    expect(ids(await tickets({ issues: { $none: {} } }), "key")).toEqual(["K4"]);
  });

  it("via: $some / $none (renamed target field in the operand)", async () => {
    expect(ids(await tickets({ labels: { $some: { name: "bug" } } }), "key")).toEqual(["K1", "K3"]);
    expect(ids(await tickets({ labels: { $none: {} } }), "key")).toEqual(["K4", "K5"]);
  });

  it("composite foreign key (NULL parts never relate)", async () => {
    const cards = (filter: Record<string, unknown>) => T("RfCard").findMany({ filter });
    expect(ids(await cards({ board: { $some: { title: "Alpha" } } }))).toEqual([1]);
    expect(ids(await cards({ board: { $none: {} } }))).toEqual([3, 4]);
  });

  it("self relation", async () => {
    expect(ids(await tickets({ parent: { $some: { status: "open" } } }), "key")).toEqual(["K2"]);
    expect(ids(await tickets({ parent: { $none: {} } }), "key")).toEqual(["K1", "K4", "K5"]);
  });

  it("nested predicates: two and three hops", async () => {
    expect(ids(await issues({ ticket: { $some: { team: { $some: { name: "Core" } } } } }))).toEqual(
      [1, 2],
    );
    const threeHops = {
      ticket: { $some: { parent: { $some: { team: { $some: { name: "Core" } } } } } },
    };
    expect(ids(await issues(threeHops))).toEqual([2, 3]);
  });

  it("predicates under $or and $not", async () => {
    expect(
      ids(await issues({ $or: [{ id: 4 }, { ticket: { $some: { status: "closed" } } }] })),
    ).toEqual([2, 4, 6]);
    expect(ids(await issues({ $not: { ticket: { $some: { status: "open" } } } }))).toEqual([
      2, 4, 5, 6,
    ]);
    // $some and $none on one key are ANDed
    expect(
      ids(await issues({ ticket: { $some: { teamId: "t1" }, $none: { status: "closed" } } })),
    ).toEqual([1]);
  });

  it("with a predicate-free conjunct (pre-match) and the $with of the same relation", async () => {
    const rows = await issues(
      { title: { $regex: "crash" }, ticket: { $some: { teamId: "t2" } } },
      { $with: [{ name: "ticket" }] },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 3, ticket: { key: "K3", teamId: "t2" } });
    expect(rows[0]).not.toHaveProperty("__atscript_rf_0");
  });

  it("sort / skip / limit / $select / findOne / count / findManyWithCount", async () => {
    const filter = { ticket: { $some: {} } };
    const page = await issues(filter, { $sort: { id: -1 }, $skip: 1, $limit: 2, $select: ["id"] });
    expect(page.map((r: any) => r.id)).toEqual([3, 2]);
    expect(Object.keys(page[0]).toSorted()).toEqual(["_id", "id"]);
    expect(await T("RfIssue").count({ filter })).toBe(4);
    expect(await T("RfIssue").count({ filter: { ticket: { $none: {} } } })).toBe(2);
    const one = await T("RfIssue").findOne({ filter, controls: { $sort: { id: -1 } } });
    expect(one.id).toBe(6);
    const withCount = await T("RfIssue").findManyWithCount({
      filter,
      controls: { $sort: { id: 1 }, $limit: 2 },
    });
    expect(withCount.count).toBe(4);
    expect(withCount.data.map((r: any) => r.id)).toEqual([1, 2]);
  });

  it("$select leaving out the FK still correlates", async () => {
    const rows = await issues(
      { ticket: { $some: { status: "open" } } },
      { $select: ["title"], $sort: { title: 1 } },
    );
    expect(rows.map((r: any) => r.title)).toEqual(["crash in web", "crash on start"]);
  });

  it("grouped aggregate (+ $count) with a predicate", async () => {
    const controls = {
      $groupBy: ["status"],
      $select: ["status", { $fn: "count", $field: "*", $as: "n" }],
      $sort: { status: 1 },
    };
    const filter = { issues: { $some: { title: { $regex: "crash" } } } };
    expect(await T("RfTicket").aggregate({ filter, controls })).toEqual([{ status: "open", n: 2 }]);
    expect(await T("RfTicket").aggregate({ filter: { issues: { $some: {} } }, controls })).toEqual([
      { status: "closed", n: 2 },
      { status: "open", n: 2 },
    ]);
    expect(
      await T("RfTicket").aggregate({ filter, controls: { ...controls, $count: true } }),
    ).toEqual([{ count: 1 }]);
  });

  it("text search + predicate (classic $text index)", async () => {
    await T("RfIssue").syncIndexes();
    const rows = await T("RfIssue").search("crash", {
      filter: { ticket: { $some: { teamId: "t2" } } },
      controls: {},
    });
    expect(ids(rows)).toEqual([3]);
    const page = await T("RfIssue").searchWithCount("crash", {
      filter: { ticket: { $some: { status: "open" } } },
      controls: {},
    });
    expect(page.count).toBe(2);
  });

  it("geo search + predicate ($geoNear keeps the predicate-free part)", async () => {
    await T("RfIssue").syncIndexes();
    const rows = await T("RfIssue").geoSearch([2.35, 48.85], {
      filter: { title: { $ne: "x" }, ticket: { $some: { teamId: "t1" } } },
      controls: {},
    });
    expect(rows.map((r: any) => r.id)).toEqual([1, 2]);
    const page = await T("RfIssue").geoSearchWithCount([2.35, 48.85], {
      filter: { ticket: { $none: { teamId: "t1" } } },
      controls: {},
    });
    expect(page.count).toBe(1);
    expect(page.data.map((r: any) => r.id)).toEqual([3]);
  });

  it("ObjectId keys: predicates both ways", async () => {
    const tasks = await T("RfTask").findMany({ filter: { project: { $some: { name: "proj1" } } } });
    expect(ids(tasks)).toEqual([1, 2]);
    const projects = await T("RfProject").findMany({
      filter: { tasks: { $some: { done: true } } },
    });
    expect(projects.map((p: any) => p.name)).toEqual(["proj1"]);
    expect(
      (await T("RfProject").findMany({ filter: { tasks: { $none: {} } } })).map((p: any) => p.name),
    ).toEqual(["proj2"]);
  });

  it("@db.rel.filter is part of a predicate (from, via with junction + target parts)", async () => {
    const teams = await T("RfTeam").findMany({ filter: { openTickets: { $some: {} } } });
    expect(ids(teams)).toEqual(["t1", "t2"]);
    // K1: bug (pinned) + hidden (pinned); K2: feature (not pinned); K3: bug (not pinned)
    expect(ids(await tickets({ pinnedLabels: { $some: {} } }), "key")).toEqual(["K1"]);
    expect(ids(await tickets({ pinnedLabels: { $some: { name: "hidden" } } }), "key")).toEqual([]);
  });
});

describe("MongoDB native views as $lookup targets", () => {
  // A relation cannot target a @db.view (the plugin rejects it), but the
  // rendered `$lookup.from` is a plain name — a native view works there.
  it("a predicate lookup reads a view", async () => {
    await db.createCollection("rf_open_tickets_view", {
      viewOn: "rf_tickets",
      pipeline: [{ $match: { status: "open" } }],
    });
    const node = new ResolvedRelationFilter({
      kind: "to",
      nav: "ticket",
      source: { table: "rf_issues", name: "rf_issues", adapter: {} as never },
      target: { table: "rf_open_tickets_view", name: "rf_open_tickets_view", adapter: {} as never },
      pairs: [{ source: "ticket_ref", target: "key" }],
      filter: {},
    });
    const rows = await db
      .collection("rf_issues")
      .aggregate(mongoFilterStages({ ticket: { $some: node } } as never))
      .toArray();
    expect(ids(rows)).toEqual([1, 3]);
  });
});

describe("MongoDB $with — @db.rel.filter and physical names", () => {
  it("from + @db.rel.filter loads only matching rows", async () => {
    const teams = await T("RfTeam").findMany({
      filter: {},
      controls: { $with: [{ name: "openTickets" }], $sort: { id: 1 } },
    });
    expect(teams.map((t: any) => [t.id, ids(t.openTickets, "key")])).toEqual([
      ["t1", ["K1"]],
      ["t2", ["K3"]],
      ["t3", []],
    ]);
  });

  it("via + @db.rel.filter applies the junction and the target parts", async () => {
    const [k1] = await tickets({ key: "K1" }, { $with: [{ name: "pinnedLabels" }] });
    expect(k1.pinnedLabels.map((l: any) => l.name)).toEqual(["bug"]);
    const [k3] = await tickets({ key: "K3" }, { $with: [{ name: "pinnedLabels" }] });
    expect(k3.pinnedLabels).toEqual([]);
  });

  it("to over a renamed FK returns the related row under logical names", async () => {
    const rows = await issues({}, { $with: [{ name: "ticket" }], $sort: { id: 1 } });
    expect(rows.map((r: any) => r.ticket?.key ?? null)).toEqual([
      "K1",
      "K2",
      "K3",
      null,
      null,
      "K5",
    ]);
    // Logical names, decrypted fields.
    expect(rows[0].ticket).toMatchObject({
      key: "K1",
      teamId: "t1",
      status: "open",
      note: "secret K1",
    });
    expect(rows[0].ticket).not.toHaveProperty("team_ref");
  });

  it("from over a renamed FK on the target", async () => {
    const rows = await tickets({}, { $with: [{ name: "issues" }], $sort: { key: 1 } });
    expect(rows.map((r: any) => [r.key, ids(r.issues)])).toEqual([
      ["K1", [1]],
      ["K2", [2]],
      ["K3", [3]],
      ["K4", []],
      ["K5", [6]],
    ]);
    expect(rows[0].issues[0]).toMatchObject({ ticketKey: "K1" });
    expect(rows[0].issues[0]).not.toHaveProperty("ticket_ref");
  });

  it("a renamed target field in the $with sub-filter / $sort / $select", async () => {
    const [k1] = await tickets(
      { key: "K1" },
      {
        $with: [
          {
            name: "labels",
            filter: { name: { $ne: "feature" } },
            controls: { $sort: { name: -1 }, $select: ["name"] },
          },
        ],
      },
    );
    expect(k1.labels.map((l: any) => l.name)).toEqual(["hidden", "bug"]);
    expect(k1.labels[0]).not.toHaveProperty("label_name");
  });

  it("a relational predicate inside a $with sub-filter", async () => {
    const teams = await T("RfTeam").findMany({
      filter: {},
      controls: {
        $sort: { id: 1 },
        $with: [
          { name: "openTickets", filter: { issues: { $some: { title: "crash on start" } } } },
        ],
      },
    });
    expect(teams.map((t: any) => ids(t.openTickets, "key"))).toEqual([["K1"], [], []]);
    expect(teams[0].openTickets[0]).not.toHaveProperty("__atscript_rf_0");
  });

  it("nested $with delegates on logical rows", async () => {
    const [issue] = await issues(
      { id: 1 },
      { $with: [{ name: "ticket", controls: { $with: [{ name: "team" }] } }] },
    );
    expect(issue.ticket.team).toMatchObject({ id: "t1", name: "Core" });
  });

  it("ObjectId keys: $with both ways (logical hex ids)", async () => {
    const [task] = await T("RfTask").findMany({
      filter: { id: 1 },
      controls: { $with: [{ name: "project" }] },
    });
    expect(task.project).toMatchObject({ _id: projectIds[0], name: "proj1" });
    const projects = await T("RfProject").findMany({
      filter: {},
      controls: { $with: [{ name: "tasks" }], $sort: { name: 1 } },
    });
    expect(projects.map((p: any) => ids(p.tasks))).toEqual([[1, 2], []]);
    expect(projects[0].tasks[0].projectId).toBe(projectIds[0]);
  });
});

describe("MongoDB relational predicates — writes", () => {
  beforeEach(seed);

  it("updateMany / replaceMany change only the matching documents", async () => {
    const result = await T("RfIssue").updateMany(
      { ticket: { $some: { status: "closed" } } },
      { title: "closed work" },
    );
    expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
    const rows = await issues({}, { $sort: { id: 1 } });
    expect(rows.filter((r: any) => r.title === "closed work").map((r: any) => r.id)).toEqual([
      2, 6,
    ]);
  });

  it("deleteMany with a predicate (and a predicate-free conjunct)", async () => {
    expect(await T("RfIssue").deleteMany({ ticket: { $none: {} } })).toEqual({ deletedCount: 2 });
    expect(
      await T("RfIssue").deleteMany({ id: { $gt: 2 }, ticket: { $some: { teamId: "t2" } } }),
    ).toEqual({ deletedCount: 1 });
    expect(ids(await issues({}))).toEqual([1, 2, 6]);
  });

  it("deleteOne with a predicate scope: out-of-scope rows answer 0", async () => {
    const scope = { ticket: { $some: { status: "open" } } };
    expect(await T("RfIssue").deleteOne(2, { scope })).toEqual({ deletedCount: 0 });
    expect(await T("RfIssue").deleteOne(1, { scope })).toEqual({ deletedCount: 1 });
    expect(ids(await issues({}))).toEqual([2, 3, 4, 5, 6]);
  });

  it("single-document adapter writes resolve one matching _id", async () => {
    const table = T("RfIssue");
    const adapter = table.getAdapter() as MongoAdapter;
    const translate = (filter: Record<string, unknown>) =>
      table._translateForAdapter({ filter }).filter;
    const none = translate({ ticket: { $some: { status: "nope" } } });
    expect(await adapter.updateOne(none, { title: "x" })).toEqual({
      matchedCount: 0,
      modifiedCount: 0,
    });
    expect(await adapter.deleteOne(none)).toEqual({ deletedCount: 0 });
    const closed = translate({ ticket: { $some: { status: "closed" } } });
    expect(await adapter.updateOne(closed, { title: "one" })).toEqual({
      matchedCount: 1,
      modifiedCount: 1,
    });
    expect(await issues({ title: "one" })).toHaveLength(1);
    const replaced = await adapter.replaceOne(translate({ id: 1, ticket: { $some: {} } }), {
      id: 1,
      title: "replaced",
      ticket_ref: "K1",
    });
    expect(replaced).toEqual({ matchedCount: 1, modifiedCount: 1 });
    expect(await adapter.deleteOne(closed)).toEqual({ deletedCount: 1 });
    expect(await T("RfIssue").count({ filter: {} })).toBe(5);
  });

  it("writes in batches of 1000 _ids with exact counts", async () => {
    const extra = Array.from({ length: 2100 }, (_, i) => ({
      id: 100 + i,
      title: "bulk",
      ticketKey: i % 2 === 0 ? "K1" : "K5",
    }));
    await T("RfIssue").insertMany(extra);
    const adapter = T("RfIssue").getAdapter() as MongoAdapter;
    const spy = vi.spyOn(adapter.collection, "updateMany");
    // The ids are streamed from the cursor batch by batch, never drained with toArray().
    const drained: unknown[] = [];
    const aggregatePipeline = adapter.aggregatePipeline.bind(adapter);
    const cursors = vi.spyOn(adapter, "aggregatePipeline").mockImplementation((pipeline) => {
      const cursor = aggregatePipeline(pipeline);
      vi.spyOn(cursor, "toArray").mockImplementation(async () => {
        drained.push(pipeline);
        return [];
      });
      return cursor;
    });
    try {
      const result = await T("RfIssue").updateMany(
        { title: "bulk", ticket: { $some: { status: "open" } } },
        { title: "bulk-open" },
      );
      expect(result).toEqual({ matchedCount: 1050, modifiedCount: 1050 });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(cursors).toHaveBeenCalledTimes(1);
      expect(drained).toEqual([]);
    } finally {
      spy.mockRestore();
      cursors.mockRestore();
    }
    expect(await T("RfIssue").count({ filter: { title: "bulk-open" } })).toBe(1050);
    expect(
      await T("RfIssue").deleteMany({ title: "bulk", ticket: { $some: { status: "closed" } } }),
    ).toEqual({ deletedCount: 1050 });
  });
});
