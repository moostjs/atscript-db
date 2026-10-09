import { DbSpace } from "@atscript/db";
import { Collection, type Db, type MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// The 0.1.151 performance pass against a real server (single-node replica
// set, so transactions run): results are unchanged by the faster paths.

let replSet: any;
let client: MongoClient;
let db: Db;
let fx: Record<string, any>;

const space = (options: ConstructorParameters<typeof MongoAdapter>[2] = {}) =>
  new DbSpace(() => new MongoAdapter(db, client, options));

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/perf-paths.as");
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

beforeEach(async () => {
  db = client.db("perf_paths");
  await db.dropDatabase();
});

async function seedAuthors(s: DbSpace) {
  const authors = s.getTable(fx.PfAuthor) as any;
  await authors.syncIndexes();
  await authors.insertMany([
    { id: 1, email: "Ann@x", name: "ann", city: "Zürich", rank: 1 },
    { id: 2, email: "bob@x", name: "bob", city: "zurich", rank: 2 },
    { id: 3, email: "cy@x", name: "cy" },
  ]);
  return authors;
}

describe("findManyWithCount (find + countDocuments)", () => {
  it("returns the same page and total as findMany + count, with collation", async () => {
    const s = space();
    const authors = await seedAuthors(s);
    for (const query of [
      { filter: {}, controls: { $sort: { id: 1 }, $skip: 1, $limit: 1 } },
      { filter: { email: "ANN@X" }, controls: {} },
      { filter: { city: "zurich" }, controls: { $sort: { id: -1 } } },
      { filter: { name: { $in: ["ann", "cy"] } }, controls: { $select: ["name"] } },
    ]) {
      const page = await authors.findManyWithCount(query);
      expect(page.data).toEqual(await authors.findMany(query));
      expect(page.count).toBe(await authors.count({ filter: query.filter }));
    }
    expect((await authors.findManyWithCount({ filter: { city: "zurich" } })).count).toBe(2);
  });

  it("runs inside a transaction (sequentially on its session)", async () => {
    const s = space();
    const authors = await seedAuthors(s);
    const page = await authors.dbAdapter.withTransaction(async () => {
      await authors.insertOne({ id: 4, email: "d@x", name: "dee" });
      return authors.findManyWithCount({ filter: {}, controls: { $sort: { id: 1 } } });
    });
    expect(page.count).toBe(4);
    expect(page.data.map((r: any) => r.id)).toEqual([1, 2, 3, 4]);
  });
});

describe("collated indexes (MG-2)", () => {
  it("a 'nocase' unique field rejects a case variant", async () => {
    const authors = await seedAuthors(space());
    await expect(authors.insertOne({ id: 9, email: "ANN@x", name: "x" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("a collated query is answered from the collated index", async () => {
    await seedAuthors(space());
    const explain = await db
      .collection("pf_authors")
      .find({ email: "ann@X" }, { collation: { locale: "en", strength: 2 } })
      .explain("queryPlanner");
    expect(JSON.stringify(explain)).toContain("atscript__unique__pf_author_email");
  });

  it("recreates a byte-wise index built before 0.1.151", async () => {
    await db.createCollection("pf_authors");
    await db
      .collection("pf_authors")
      .createIndex({ email: 1 }, { name: "atscript__unique__pf_author_email", unique: true });
    await (space().getTable(fx.PfAuthor) as any).syncIndexes();
    const index = (await db.collection("pf_authors").listIndexes().toArray()).find(
      (i) => i.name === "atscript__unique__pf_author_email",
    );
    expect(index?.collation).toMatchObject({ locale: "en", strength: 2 });
  });
});

describe("collated index migration safety (MG-2)", () => {
  it("keeps a byte-wise unique index when case variants would violate the collated one", async () => {
    const raw = db.collection("pf_authors");
    await db.createCollection("pf_authors");
    await raw.createIndex(
      { email: 1 },
      { name: "atscript__unique__pf_author_email", unique: true },
    );
    await raw.insertMany([
      { _id: 1 as any, email: "Ann@x", name: "a" },
      { _id: 2 as any, email: "ann@x", name: "b" },
    ]);
    await expect((space().getTable(fx.PfAuthor) as any).syncIndexes()).rejects.toThrow(
      /current index is kept/,
    );
    const index = (await raw.listIndexes().toArray()).find(
      (i) => i.name === "atscript__unique__pf_author_email",
    );
    expect(index).toMatchObject({ unique: true });
    expect(index?.collation).toBeUndefined();
    await expect(raw.insertOne({ _id: 3 as any, email: "Ann@x", name: "c" })).rejects.toThrow(
      /E11000/,
    );
  });

  it("does not rebuild byte-wise indexes on a collection with a default collation", async () => {
    await db.createCollection("pf_authors", { collation: { locale: "fr", strength: 1 } });
    await (space().getTable(fx.PfAuthor) as any).syncIndexes();
    const drop = vi.spyOn(Collection.prototype, "dropIndex");
    const create = vi.spyOn(Collection.prototype, "createIndex");
    try {
      await (space().getTable(fx.PfAuthor) as any).syncIndexes();
      expect(drop).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    } finally {
      drop.mockRestore();
      create.mockRestore();
    }
  });
});

describe("estimatedCount (MG-6)", () => {
  it("an unfiltered estimate equals the exact count on a clean collection", async () => {
    const authors = await seedAuthors(space({ estimatedCount: true }));
    expect(await authors.count({ filter: {} })).toBe(3);
    expect((await authors.findManyWithCount({ filter: {} })).count).toBe(3);
    expect(await authors.count({ filter: { name: "ann" } })).toBe(1);
  });
});

describe("ungrouped aggregate over no rows (MG-7)", () => {
  it("answers like before with and without $having", async () => {
    const posts = space().getTable(fx.PfPost) as any;
    await posts.insertOne({ id: 1, title: "a", score: 3 });
    const select = [{ $fn: "count", $field: "*", $as: "n" }];
    const agg = (filter: unknown, extra: Record<string, unknown> = {}) =>
      posts.aggregate({ filter, controls: { $select: select, ...extra } });
    expect(await agg({ title: "none" })).toEqual([{ n: 0 }]);
    expect(await agg({ title: "none" }, { $skip: 1 })).toEqual([]);
    expect(await agg({ title: "none" }, { $having: { n: { $gte: 0 } } })).toEqual([{ n: 0 }]);
    expect(await agg({ title: "none" }, { $having: { n: { $gt: 0 } } })).toEqual([]);
    expect(await agg({ title: "a" }, { $having: { n: { $gt: 5 } } })).toEqual([]);
    expect(await agg({ title: "a" })).toEqual([{ n: 1 }]);
  });
});

describe("@db.default.increment inside a transaction (C6)", () => {
  it("concurrent transactions allocate without write conflicts (no retries)", async () => {
    const tickets = space().getTable(fx.PfTicket) as any;
    await tickets.insertOne({ subject: "first" });
    let runs = 0;
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        tickets.dbAdapter.withTransaction(async () => {
          runs++;
          await tickets.insertOne({ subject: `tx${i}` });
          await new Promise((resolve) => setTimeout(resolve, 50));
        }),
      ),
    );
    expect(runs).toBe(5);
    const ids = (await tickets.findMany({ filter: {}, controls: {} })).map((r: any) => r.id);
    expect(new Set(ids).size).toBe(6);
  });

  it("a fresh counter inside a transaction sees the transaction's own rows", async () => {
    const tickets = space().getTable(fx.PfTicket) as any;
    await tickets.dbAdapter.withTransaction(async () => {
      await tickets.insertOne({ id: 7, subject: "explicit" });
      await tickets.insertOne({ subject: "allocated" });
    });
    const rows = await tickets.findMany({ filter: {}, controls: { $sort: { id: 1 } } });
    expect(rows.map((r: any) => r.id)).toEqual([7, 8]);
  });
});
