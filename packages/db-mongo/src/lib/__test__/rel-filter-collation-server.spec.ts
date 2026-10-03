import { DbError, DbSpace } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Relational predicates vs `@db.column.collate` (mongodb-memory-server), since
// 0.1.147: a predicate pipeline runs WITHOUT an operation-wide collation (it
// would govern every `$lookup` — join keys and the related table's fields);
// each table's 'nocase' fields are compared case-insensitively explicitly.

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;

const T = (name: string) => space.getTable(fx[name]) as any;
const ids = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => r.id).toSorted((a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0));
const members = (filter: Record<string, unknown>, controls: Record<string, unknown> = {}) =>
  T("RcMember").findMany({ filter, controls });
const teams = (filter: Record<string, unknown>) => T("RcTeam").findMany({ filter });

async function seed() {
  await db.dropDatabase();
  space = new DbSpace(() => new MongoAdapter(db, client));
  // Two team ids that differ only in case: the join must stay byte-wise.
  await T("RcTeam").insertMany([
    { id: "t1", name: "Core" },
    { id: "T1", name: "Other" },
  ]);
  await T("RcMember").insertMany([
    { id: 1, teamId: "t1", nick: "amy", role: "admin", city: "Zürich" },
    { id: 2, teamId: "T1", nick: "bob", role: "dev" },
  ]);
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rel-filter-coll.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("rel_filter_coll");
  await seed();
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

async function rejection(run: () => Promise<unknown>): Promise<DbError> {
  let error: unknown;
  try {
    await run();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(DbError);
  return error as DbError;
}

describe("MongoDB predicates and per-field collation — reads", () => {
  it("predicate-free reads keep the operation-wide collation", async () => {
    const adapter = T("RcTeam").getAdapter() as MongoAdapter;
    const spy = vi.spyOn(adapter.collection, "find");
    try {
      expect(ids(await teams({ name: "CORE" }))).toEqual(["t1"]);
      expect(spy.mock.calls[0]![1]).toMatchObject({ collation: { locale: "en", strength: 2 } });
    } finally {
      spy.mockRestore();
    }
    expect(await T("RcMember").count({ filter: { nick: "AMY" } })).toBe(1);
    expect(await T("RcMember").count({ filter: { city: "zurich" } })).toBe(1);
  });

  it("a target 'nocase' field inside $some compares case-insensitively", async () => {
    expect(ids(await members({ team: { $some: { name: "CORE" } } }))).toEqual([1]);
    expect(ids(await members({ team: { $none: { name: "core" } } }))).toEqual([2]);
    expect(ids(await teams({ members: { $some: { nick: "BOB" } } }))).toEqual(["T1"]);
  });

  it("a source 'nocase' condition does not make the FK join case-insensitive", async () => {
    // bob → team "T1" (Other), never team "t1" (Core).
    expect(ids(await members({ nick: "BOB", team: { $some: { name: "Other" } } }))).toEqual([2]);
    expect(ids(await members({ nick: "BOB", team: { $some: { name: "Core" } } }))).toEqual([]);
    expect(await T("RcMember").count({ filter: { nick: "BOB", team: { $some: {} } } })).toBe(1);
    const page = await T("RcMember").findManyWithCount({
      filter: { nick: { $in: ["AMY", "BOB"] }, team: { $some: { name: "core" } } },
      controls: {},
    });
    expect([page.count, ids(page.data)]).toEqual([1, [1]]);
  });

  it("a binary target field stays case-sensitive, with or without a source 'nocase' condition", async () => {
    expect(ids(await teams({ name: "core", members: { $some: { role: "ADMIN" } } }))).toEqual([]);
    expect(ids(await teams({ members: { $some: { role: "ADMIN" } } }))).toEqual([]);
    expect(ids(await teams({ name: "core", members: { $some: { role: "admin" } } }))).toEqual([
      "t1",
    ]);
    const one = await T("RcTeam").findOne({
      filter: { name: { $ne: "OTHER" }, members: { $some: { role: "admin" } } },
    });
    expect(one?.id).toBe("t1");
  });

  it("predicate pipelines run without an operation-wide collation", async () => {
    const adapter = T("RcMember").getAdapter() as MongoAdapter;
    const spy = vi.spyOn(adapter.collection, "aggregate");
    try {
      await members({ nick: "AMY", team: { $some: {} } });
      expect(spy.mock.calls[0]![1]).not.toHaveProperty("collation");
    } finally {
      spy.mockRestore();
    }
  });

  it("collation-sensitive comparisons that cannot be rendered per field are rejected", async () => {
    const range = await rejection(() => members({ nick: { $gt: "a" }, team: { $some: {} } }));
    expect(range.code).toBe("REL_FILTER_NOT_SUPPORTED");
    expect(range.errors[0]!.path).toBe("nick");
    const unicode = await rejection(() => teams({ members: { $some: { city: "zurich" } } }));
    expect(unicode.code).toBe("REL_FILTER_NOT_SUPPORTED");
    expect(unicode.errors[0]!.path).toBe("city");
    // $regex and $exists are not collation-sensitive.
    expect(ids(await teams({ members: { $some: { city: { $exists: true } } } }))).toEqual(["t1"]);
    expect(ids(await members({ nick: { $regex: "^a" }, team: { $some: {} } }))).toEqual([1]);
  });

  it("grouped aggregates and $with sub-filters with a predicate follow the same rule", async () => {
    const controls = {
      $groupBy: ["role"],
      $select: ["role", { $fn: "count", $field: "*", $as: "n" }],
    };
    const filter = { nick: "AMY", team: { $some: { name: "CORE" } } };
    expect(await T("RcMember").aggregate({ filter, controls })).toEqual([{ role: "admin", n: 1 }]);
    expect(
      await T("RcMember").aggregate({ filter, controls: { ...controls, $count: true } }),
    ).toEqual([{ count: 1 }]);
    const [core] = await T("RcTeam").findMany({
      filter: { id: "t1" },
      controls: { $with: [{ name: "members", filter }] },
    });
    expect(ids(core.members)).toEqual([1]);
  });

  it("$with under a source collation joins byte-wise", async () => {
    const [bob] = await members({ nick: "BOB" }, { $with: [{ name: "team" }] });
    expect(bob.team).toMatchObject({ id: "T1", name: "Other" });
    const [core] = await T("RcTeam").findMany({
      filter: { name: "CORE" },
      controls: { $with: [{ name: "members" }] },
    });
    expect(ids(core.members)).toEqual([1]);
  });
});

describe("MongoDB predicates and per-field collation — writes", () => {
  beforeEach(seed);

  it("a predicate write compares 'nocase' fields like the read (and re-checks them)", async () => {
    const filter = { nick: "AMY", team: { $some: { name: "CORE" } } };
    expect(await T("RcMember").count({ filter })).toBe(1);
    expect(await T("RcMember").updateMany(filter, { role: "lead" })).toEqual({
      matchedCount: 1,
      modifiedCount: 1,
    });
    expect((await members({ id: 1 }))[0].role).toBe("lead");
    expect(
      await T("RcMember").deleteMany({ nick: "BOB", team: { $some: { name: "core" } } }),
    ).toEqual({ deletedCount: 0 });
    expect(
      await T("RcMember").deleteMany({ nick: "BOB", team: { $some: { name: "OTHER" } } }),
    ).toEqual({ deletedCount: 1 });
    expect(ids(await members({}))).toEqual([1]);
  });
});
