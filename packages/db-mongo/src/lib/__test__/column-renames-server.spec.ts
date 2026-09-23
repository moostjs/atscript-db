import { AtscriptDbTable, DbSpace } from "@atscript/db";
import type { Collection, Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// `@db.column` renames on the non-grouped read path, against a real MongoDB
// (mongodb-memory-server): `$select` and `$sort` must reach the driver under
// the PHYSICAL key (a logical key projects nothing / sorts by nothing), and
// rows must come back under the logical name. MongoDB renames the top-level
// key only — `profile.bio` under `@db.column 'prof'` is stored as `prof.bio`.

let server: any;
let client: MongoClient;
let db: Db;
let raw: Collection;
let table: AtscriptDbTable;

// Insertion order deliberately differs from every sort order asserted below.
const ROWS = [
  { id: 1, title: "b", renamedAt: 200, profile: { bio: "y", rank: 1 } },
  { id: 2, title: "c", renamedAt: 100, profile: { bio: "z", rank: 3 } },
  { id: 3, title: "a", renamedAt: 300, profile: { bio: "x", rank: 2 } },
];

beforeAll(async () => {
  await prepareFixtures();
  const { ColumnRename } = await import("./fixtures/column-renames.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("column_renames");
  table = new DbSpace(() => new MongoAdapter(db, client)).getTable(ColumnRename as never);
  raw = db.collection("column_renames");
  await table.insertMany(ROWS as never);
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

/** Row ids in result order. */
function ids(rows: unknown[]): number[] {
  return rows.map((r) => (r as { id: number }).id);
}

/** Rows without Mongo's `_id`. */
function strip(rows: Array<Record<string, unknown>>) {
  return rows.map(({ _id, ...rest }) => rest);
}

describe("@db.column renames on findMany / findManyWithCount (MongoDB)", () => {
  it("stores the renamed keys physically", async () => {
    const doc = await raw.findOne({ id: 1 });
    expect(doc).toMatchObject({ opened_on: 200, prof: { bio: "y", rank: 1 } });
    expect(doc).not.toHaveProperty("renamedAt");
    expect(doc).not.toHaveProperty("profile");
  });

  it("$select (array form) returns the renamed field under its logical name", async () => {
    const rows = await table.findMany({
      filter: {},
      controls: { $select: ["id", "renamedAt"], $sort: { id: 1 } },
    });
    expect(strip(rows as never)).toEqual([
      { id: 1, renamedAt: 200 },
      { id: 2, renamedAt: 100 },
      { id: 3, renamedAt: 300 },
    ]);
  });

  it("$select of a dotted path under a renamed object", async () => {
    const rows = await table.findMany({
      filter: {},
      controls: { $select: ["id", "profile.bio"], $sort: { id: 1 } },
    });
    expect(strip(rows as never)).toEqual([
      { id: 1, profile: { bio: "y" } },
      { id: 2, profile: { bio: "z" } },
      { id: 3, profile: { bio: "x" } },
    ]);
  });

  it("$select exclusion form drops the renamed fields", async () => {
    const rows = await table.findMany({
      filter: {},
      controls: { $select: { renamedAt: 0, profile: 0 }, $sort: { id: 1 } },
    });
    expect(strip(rows as never)).toEqual([
      { id: 1, title: "b" },
      { id: 2, title: "c" },
      { id: 3, title: "a" },
    ]);
  });

  it("$sort by a renamed field, ascending and descending", async () => {
    const asc = await table.findMany({ filter: {}, controls: { $sort: { renamedAt: 1 } } });
    expect(ids(asc)).toEqual([2, 1, 3]);
    const desc = await table.findMany({ filter: {}, controls: { $sort: { renamedAt: -1 } } });
    expect(ids(desc)).toEqual([3, 1, 2]);
    expect(desc[0]).toMatchObject({ renamedAt: 300, profile: { bio: "x", rank: 2 } });
  });

  it("$sort by a dotted path under a renamed object", async () => {
    const rows = await table.findMany({ filter: {}, controls: { $sort: { "profile.rank": -1 } } });
    expect(ids(rows)).toEqual([2, 3, 1]);
  });

  it("filters on a renamed field and a dotted path under a renamed object", async () => {
    const byScalar = await table.findMany({
      filter: { renamedAt: { $gte: 200 } },
      controls: { $sort: { id: 1 } },
    });
    expect(ids(byScalar)).toEqual([1, 3]);
    const byNested = await table.findMany({ filter: { "profile.bio": "z" }, controls: {} });
    expect(ids(byNested)).toEqual([2]);
  });

  it("findManyWithCount applies $select / $sort in its $facet", async () => {
    const res = await table.findManyWithCount({
      filter: { renamedAt: { $gte: 100 } },
      controls: { $select: ["id", "renamedAt"], $sort: { renamedAt: -1 }, $limit: 2 },
    });
    expect(res.count).toBe(3);
    expect(strip(res.data as never)).toEqual([
      { id: 3, renamedAt: 300 },
      { id: 1, renamedAt: 200 },
    ]);
  });

  it("findOne honours a renamed $select", async () => {
    const row = await table.findOne({ filter: { id: 2 }, controls: { $select: ["renamedAt"] } });
    expect(row).toMatchObject({ renamedAt: 100 });
    expect(row).not.toHaveProperty("title");
    expect(row).not.toHaveProperty("opened_on");
  });
});
