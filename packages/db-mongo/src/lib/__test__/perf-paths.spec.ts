import { DbSpace } from "@atscript/db";
import { ObjectId } from "mongodb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { splitVectorPreFilter } from "../mongo-search";
import { prepareFixtures } from "./test-utils";

// Read / write paths of the 0.1.151 performance pass, against a recording
// fake collection — no server (the server-backed equivalents live in
// perf-paths-server.spec.ts).

type Call = { method: string; args: unknown[]; at: number };

let fx: Record<string, any>;
let calls: Call[];
let tick: number;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/perf-paths.as");
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fake collection; `aggregateRows` answers each aggregate by its pipeline. */
function fakeCollection(
  aggregateRows: (pipeline: Array<Record<string, any>>) => unknown[] = () => [],
  findRows: unknown[] = [],
) {
  const record = (method: string, args: unknown[]) => calls.push({ method, args, at: tick++ });
  const cursor = (rows: () => unknown[], method: string) => ({
    toArray: async () => {
      await Promise.resolve();
      record(`${method}:done`, []);
      return rows();
    },
  });
  return {
    find: (...args: unknown[]) => {
      record("find", args);
      return cursor(() => findRows, "find");
    },
    findOne: async (...args: unknown[]) => {
      record("findOne", args);
      return null;
    },
    aggregate: (...args: unknown[]) => {
      record("aggregate", args);
      return cursor(() => aggregateRows(args[0] as Array<Record<string, any>>), "aggregate");
    },
    countDocuments: async (...args: unknown[]) => {
      record("countDocuments", args);
      return 7;
    },
    estimatedDocumentCount: async (...args: unknown[]) => {
      record("estimatedDocumentCount", args);
      return 9;
    },
    findOneAndUpdate: async (...args: unknown[]) => {
      record("findOneAndUpdate", args);
      return { seq: 1 };
    },
    updateOne: async (...args: unknown[]) => {
      record("updateOne", args);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    insertOne: async (...args: unknown[]) => {
      record("insertOne", args);
      return { insertedId: 1 };
    },
  };
}

function fakeDb(collection: ReturnType<typeof fakeCollection>): never {
  return { databaseName: "fake", collection: () => collection } as never;
}

function setup(
  options: ConstructorParameters<typeof MongoAdapter>[2] = {},
  collection = fakeCollection(),
  client?: unknown,
) {
  calls = [];
  tick = 0;
  const db = fakeDb(collection);
  const space = new DbSpace(() => new MongoAdapter(db, client as never, options));
  return { space, T: (type: any) => space.getTable(type) as any };
}

const methods = () => calls.map((c) => c.method).filter((m) => !m.endsWith(":done"));
const SESSION = { id: "fake-session" };
/** Runs `fn` as inside a transaction of the adapter (its session handed out). */
const inTx = <T>(adapter: unknown, fn: () => Promise<T>): Promise<T> =>
  (
    adapter as { _runInTransactionContext: (s: unknown, f: () => Promise<T>) => Promise<T> }
  )._runInTransactionContext(SESSION, fn);

// ── MG-1 findManyWithCount ───────────────────────────────────────────────────

describe("findManyWithCount without predicates: find + countDocuments", () => {
  it("runs both concurrently with the same filter, sort, page and collation", async () => {
    const { T } = setup();
    const page = await T(fx.PfAuthor).findManyWithCount({
      filter: { email: "A@x" },
      controls: { $sort: { name: 1 }, $skip: 2, $limit: 3 },
    });
    expect(page.count).toBe(7);
    expect(methods()).toEqual(["find", "countDocuments"]);
    // Both started before either finished.
    const findDone = calls.find((c) => c.method === "find:done")!.at;
    expect(calls.find((c) => c.method === "countDocuments")!.at).toBeLessThan(findDone);
    const [filter, findOpts] = calls[0]!.args as [unknown, Record<string, unknown>];
    expect(filter).toEqual({ email: "A@x" });
    expect(findOpts).toMatchObject({
      sort: { name: 1 },
      skip: 2,
      limit: 3,
      collation: { locale: "en", strength: 2 },
    });
    const count = calls.find((c) => c.method === "countDocuments")!;
    expect(count.args).toEqual([{ email: "A@x" }, { collation: { locale: "en", strength: 2 } }]);
  });

  it("runs them one after the other inside a transaction, both on its session", async () => {
    const { space, T } = setup();
    const adapter = space.getAdapter(fx.PfPost);
    await inTx(adapter, () => T(fx.PfPost).findManyWithCount({ filter: { title: "t" } }));
    const findDone = calls.find((c) => c.method === "find:done")!.at;
    const count = calls.find((c) => c.method === "countDocuments")!;
    expect(count.at).toBeGreaterThan(findDone);
    expect((calls[0]!.args[1] as Record<string, unknown>).session).toBe(SESSION);
    expect((count.args[1] as Record<string, unknown>).session).toBe(SESSION);
  });
});

// ── MG-6 estimated count ─────────────────────────────────────────────────────

describe("estimatedCount (opt-in)", () => {
  it("is off by default: an unfiltered count counts documents", async () => {
    const { T } = setup();
    expect(await T(fx.PfPost).count({ filter: {} })).toBe(7);
    expect(methods()).toEqual(["countDocuments"]);
  });

  it("answers an unfiltered count — and findManyWithCount's total — from metadata", async () => {
    const { T } = setup({ estimatedCount: true });
    expect(await T(fx.PfPost).count({ filter: {} })).toBe(9);
    expect((await T(fx.PfPost).findManyWithCount({ filter: {} })).count).toBe(9);
    expect(methods()).toEqual(["estimatedDocumentCount", "find", "estimatedDocumentCount"]);
  });

  it("still counts exactly when filtered, in a transaction, or for an unlisted table", async () => {
    const { space, T } = setup({ estimatedCount: ["pf_posts"] });
    expect(await T(fx.PfPost).count({ filter: { title: "x" } })).toBe(7);
    await inTx(space.getAdapter(fx.PfPost), () => T(fx.PfPost).count({ filter: {} }));
    expect(await T(fx.PfAuthor).count({ filter: {} })).toBe(7);
    expect(methods()).toEqual(["countDocuments", "countDocuments", "countDocuments"]);
    expect(await T(fx.PfPost).count({ filter: {} })).toBe(9);
  });
});

// ── C6 increments inside the session ─────────────────────────────────────────

describe("@db.default.increment allocation inside a transaction", () => {
  it("advances the counter outside the session; the max probe joins it", async () => {
    const { space } = setup();
    const adapter = space.getAdapter(fx.PfTicket) as MongoAdapter;
    space.getTable(fx.PfTicket).getMetadata();
    await inTx(adapter, () => adapter.insertOne({ subject: "s" }));
    const counter = calls.find((c) => c.method === "findOneAndUpdate")!;
    expect(counter.args[2]).toEqual({ upsert: true, returnDocument: "after" });
    const max = calls.find((c) => c.method === "aggregate")!;
    expect(max.args[1]).toEqual({ session: SESSION });
    expect(calls.find((c) => c.method === "insertOne")!.args[1]).toEqual({ session: SESSION });
  });
});

// ── MG-7 ungrouped aggregate over no rows ────────────────────────────────────

describe("ungrouped aggregate over no rows", () => {
  const select = (extra: Record<string, unknown> = {}) => ({
    filter: { title: "none" },
    controls: { $select: [{ $fn: "count", $field: "*", $as: "n" }], ...extra },
  });

  it("returns the empty group without a probe round trip when there is no $having", async () => {
    const { T } = setup();
    expect(await T(fx.PfPost).aggregate(select())).toEqual([{ n: 0 }]);
    expect(await T(fx.PfPost).aggregate(select({ $limit: 5 }))).toEqual([{ n: 0 }]);
    expect(await T(fx.PfPost).aggregate(select({ $skip: 1 }))).toEqual([]);
    expect(await T(fx.PfPost).aggregate(select({ $count: true }))).toEqual([{ count: 1 }]);
    expect(methods()).toEqual(["aggregate", "aggregate", "aggregate", "aggregate"]);
  });

  it("with $having runs the probe and the $having check together", async () => {
    // The probe finds nothing; the server keeps the empty group under `$having`.
    const collection = fakeCollection((pipeline) =>
      pipeline.some((s) => s.$replaceRoot) ? [{ n: 0 }] : [],
    );
    const { T } = setup({}, collection);
    const rows = await T(fx.PfPost).aggregate(select({ $having: { n: { $gte: 0 } } }));
    expect(rows).toEqual([{ n: 0 }]);
    expect(methods()).toEqual(["aggregate", "aggregate", "aggregate"]);
    // Probe and `$having` check started before the probe finished.
    const second = calls.filter((c) => c.method === "aggregate")[2]!;
    const probeDone = calls.filter((c) => c.method === "aggregate:done")[1]!;
    expect(second.at).toBeLessThan(probeDone.at);
  });

  it("with $having and a matching row there is no empty group", async () => {
    const collection = fakeCollection((pipeline) =>
      pipeline.at(-1)?.$project?._id === 1 ? [{ _id: 1 }] : [],
    );
    const { T } = setup({}, collection);
    expect(await T(fx.PfPost).aggregate(select({ $having: { n: { $gt: 5 } } }))).toEqual([]);
  });
});

// ── MG-3 $with lookups by field ──────────────────────────────────────────────

describe("search with count", () => {
  function mocked(rows: (pipeline: Array<Record<string, any>>) => unknown[]) {
    const { space } = setup();
    space.getTable(fx.PfDoc).getMetadata();
    const adapter = space.getAdapter(fx.PfDoc) as MongoAdapter;
    const aggregate = vi.fn((pipeline: Array<Record<string, any>>) => {
      calls.push({ method: "aggregate", args: [pipeline], at: tick++ });
      return { toArray: async () => rows(pipeline) };
    });
    vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);
    return space.getTable(fx.PfDoc) as any;
  }

  it("an unfiltered Atlas search reads the page directly and the total from $searchMeta", async () => {
    const table = mocked((pipeline) =>
      pipeline[0]!.$searchMeta ? [{ count: { total: 42 } }] : [{ _id: "a", title: "t" }],
    );
    const result = await table.searchWithCount("hello", {
      filter: {},
      controls: { $skip: 10, $limit: 5 },
    });
    expect(result.count).toBe(42);
    expect(result.data).toHaveLength(1);
    const [page, meta] = calls.map((c) => c.args[0] as Array<Record<string, any>>);
    expect(Object.keys(page![0]!)).toEqual(["$search"]);
    expect(page!.slice(1)).toEqual([{ $skip: 10 }, { $limit: 5 }]);
    expect(meta).toEqual([{ $searchMeta: { ...page![0]!.$search, count: { type: "total" } } }]);
  });

  it("a filtered search keeps the $facet count", async () => {
    const table = mocked(() => [{ data: [], meta: [{ count: 3 }] }]);
    const result = await table.searchWithCount("hello", { filter: { status: "x" } });
    expect(result.count).toBe(3);
    expect(calls).toHaveLength(1);
    const pipeline = calls[0]!.args[0] as Array<Record<string, any>>;
    expect(pipeline.at(-1)!.$facet).toBeDefined();
  });
});

describe("vector search pre-filters", () => {
  function vectorPipeline() {
    const { space } = setup();
    space.getTable(fx.PfDoc).getMetadata();
    const adapter = space.getAdapter(fx.PfDoc) as MongoAdapter;
    const aggregate = vi.fn((_pipeline: unknown) => ({ toArray: async () => [] }));
    vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);
    return { table: space.getTable(fx.PfDoc) as any, aggregate };
  }

  it("declares every @db.search.filter field in the vector index", async () => {
    const { space } = setup();
    space.getTable(fx.PfDoc).getMetadata();
    const adapter = space.getAdapter(fx.PfDoc) as MongoAdapter;
    const index = adapter.getMongoSearchIndex("embedding") as any;
    expect(index.definition.fields).toEqual([
      expect.objectContaining({ type: "vector", path: "embedding" }),
      { type: "filter", path: "category" },
      { type: "filter", path: "year" },
    ]);
  });

  it("moves filter-field conjuncts into $vectorSearch.filter; the rest filters after", async () => {
    const { table, aggregate } = vectorPipeline();
    await table.vectorSearch([1, 0, 0], {
      filter: { category: "a", year: { $gte: 2000 }, status: "live" },
      controls: { $skip: 10, $limit: 5 },
    });
    const pipeline = aggregate.mock.calls[0]![0] as Array<Record<string, any>>;
    expect(pipeline[0]!.$vectorSearch).toMatchObject({
      filter: { $and: [{ category: { $eq: "a" } }, { year: { $gte: 2000 } }] },
      limit: 15,
      numCandidates: 150,
    });
    expect(pipeline.slice(1)).toEqual([
      { $match: { status: "live" } },
      { $skip: 10 },
      { $limit: 5 },
    ]);
  });

  it("keeps numCandidates within the Atlas cap (10000) for deep pages", async () => {
    const { table, aggregate } = vectorPipeline();
    await table.vectorSearch([1, 0, 0], { filter: {}, controls: { $skip: 1500, $limit: 100 } });
    const pipeline = aggregate.mock.calls[0]![0] as Array<Record<string, any>>;
    expect(pipeline[0]!.$vectorSearch).toMatchObject({ limit: 1600, numCandidates: 10_000 });
  });

  it("with count: the same split before the $facet", async () => {
    const { table, aggregate } = vectorPipeline();
    await table.vectorSearchWithCount([1, 0, 0], {
      filter: { category: { $in: ["a", "b"] } },
      controls: { $limit: 5 },
    });
    const pipeline = aggregate.mock.calls[0]![0] as Array<Record<string, any>>;
    expect(pipeline[0]!.$vectorSearch.filter).toEqual({ category: { $in: ["a", "b"] } });
    expect(pipeline[1]).toEqual({ $match: {} });
    expect(pipeline[2]!.$facet).toBeDefined();
  });

  describe("splitVectorPreFilter", () => {
    const paths = new Set(["category", "year", "owner"]);
    const oid = new ObjectId();
    const at = new Date(5);
    it.each([
      [{ category: "a" }, { category: { $eq: "a" } }, {}],
      [{ year: 2020 }, { year: { $eq: 2020 } }, {}],
      [{ owner: oid }, { owner: { $eq: oid } }, {}],
      [{ year: { $gt: 1, $lte: 5 } }, { year: { $gt: 1, $lte: 5 } }, {}],
      [{ category: { $nin: ["x"] } }, { category: { $nin: ["x"] } }, {}],
      [{ category: { $ne: at } }, { category: { $ne: at } }, {}],
    ])("moves %j", (filter, pre, rest) => {
      expect(splitVectorPreFilter(filter as never, paths)).toEqual({ pre, rest });
    });

    it.each([
      [{ category: null }],
      [{ category: { $eq: null } }],
      [{ category: { $regex: "a" } }],
      [{ category: /a/ }],
      [{ category: { $in: [] } }],
      [{ category: { $in: ["a", null] } }],
      [{ category: { $exists: true } }],
      [{ year: Number.NaN }],
      [{ year: { $gt: 1, $mod: [2, 0] } }],
      [{ status: "x" }],
      [{ $or: [{ category: "a" }, { category: "b" }] }],
      [{ category: ["a"] }],
    ])("keeps %j after the search", (filter) => {
      expect(splitVectorPreFilter(filter as never, paths)).toEqual({ rest: filter });
    });

    it("splits $and members and keeps the rest's shape", () => {
      expect(
        splitVectorPreFilter(
          {
            $and: [{ category: "a" }, { $or: [{ status: "x" }, { status: "y" }] }],
            year: 1,
          } as never,
          paths,
        ),
      ).toEqual({
        pre: { $and: [{ category: { $eq: "a" } }, { year: { $eq: 1 } }] },
        rest: { $or: [{ status: "x" }, { status: "y" }] },
      });
    });

    it("moves nothing without filter fields", () => {
      expect(splitVectorPreFilter({ category: "a" } as never, new Set())).toEqual({
        rest: { category: "a" },
      });
    });
  });
});

// ── MG-2 collated indexes ────────────────────────────────────────────────────

describe("schema sync builds plain / unique indexes with the fields' collation", () => {
  function syncHost(
    existing: Array<Record<string, unknown>>,
    { duplicates = [] as unknown[], defaultCollation = undefined as unknown } = {},
  ) {
    const { space } = setup();
    space.getTable(fx.PfAuthor).getMetadata();
    const adapter = space.getAdapter(fx.PfAuthor) as MongoAdapter;
    const createIndex = vi.fn(async () => "ok");
    const dropIndex = vi.fn(async () => undefined);
    const aggregate = vi.fn((_pipeline: unknown, _options: unknown) => ({
      toArray: async () => duplicates,
    }));
    const db = Object.create((adapter as any).db);
    db.listCollections = (() => ({
      next: async () => ({ name: "pf_authors", options: { collation: defaultCollation } }),
    })) as never;
    Object.defineProperty(adapter, "db", { value: db });
    vi.spyOn(adapter, "collection", "get").mockReturnValue({
      collectionName: "pf_authors",
      aggregate,
      listIndexes: () => ({ toArray: async () => existing }),
      createIndex,
      dropIndex,
      listSearchIndexes: () => ({
        toArray: async () => {
          throw new Error("not Atlas");
        },
      }),
    } as never);
    vi.spyOn(adapter, "ensureCollectionExists").mockResolvedValue(undefined);
    return { adapter, createIndex, dropIndex, aggregate };
  }

  const options = (createIndex: ReturnType<typeof vi.fn>) =>
    new Map(
      createIndex.mock.calls.map((call) => {
        const opts = (call as unknown[])[1] as { name: string };
        return [opts.name, opts];
      }),
    );

  it("creates them with the query collation (unicode wins in a compound index)", async () => {
    const { adapter, createIndex } = syncHost([]);
    await adapter.syncIndexes();
    const byName = options(createIndex);
    expect(byName.get("atscript__unique__pf_author_email")).toMatchObject({
      unique: true,
      collation: { locale: "en", strength: 2 },
    });
    expect(byName.get("atscript__plain__pf_author_city_name")).toMatchObject({
      collation: { locale: "en", strength: 1 },
    });
    expect(byName.get("atscript__plain__pf_author_name")).not.toHaveProperty("collation");
  });

  it("recreates an index whose collation drifted and keeps the matching ones", async () => {
    const { adapter, createIndex, dropIndex } = syncHost([
      // Built before 0.1.151: byte-wise.
      { name: "atscript__unique__pf_author_email", key: { email: 1 }, unique: true },
      {
        name: "atscript__plain__pf_author_city_name",
        key: { city: 1, rank: 1 },
        collation: { locale: "en", strength: 1, caseLevel: false, version: "57.1" },
      },
      { name: "atscript__plain__pf_author_name", key: { name: 1 } },
      { name: "atscript__unique___pk", key: { id: 1 }, unique: true },
    ]);
    await adapter.syncIndexes();
    expect(dropIndex.mock.calls).toEqual([["atscript__unique__pf_author_email"]]);
    expect([...options(createIndex).keys()]).toEqual(["atscript__unique__pf_author_email"]);
  });

  it("keeps a unique index whose collated replacement the data violates", async () => {
    const { adapter, createIndex, dropIndex, aggregate } = syncHost(
      [{ name: "atscript__unique__pf_author_email", key: { email: 1 }, unique: true }],
      { duplicates: [{ _id: { email: "ann@x" }, n: 2 }] },
    );
    await expect(adapter.syncIndexes()).rejects.toThrow(/current index is kept/);
    expect(aggregate.mock.calls[0]![1]).toMatchObject({ collation: { locale: "en", strength: 2 } });
    expect(dropIndex).not.toHaveBeenCalled();
    expect(options(createIndex).has("atscript__unique__pf_author_email")).toBe(false);
  });

  it("an index inheriting the collection's default collation counts as byte-wise", async () => {
    const { adapter, dropIndex } = syncHost(
      [
        {
          name: "atscript__plain__pf_author_name",
          key: { name: 1 },
          collation: { locale: "fr", strength: 1 },
        },
      ],
      { defaultCollation: { locale: "fr", strength: 1 } },
    );
    await adapter.syncIndexes();
    expect(dropIndex.mock.calls).not.toContainEqual(["atscript__plain__pf_author_name"]);
  });

  it("drops the collation of an index whose fields became byte-wise", async () => {
    const { adapter, dropIndex } = syncHost([
      {
        name: "atscript__plain__pf_author_name",
        key: { name: 1 },
        collation: { locale: "en", strength: 2 },
      },
    ]);
    await adapter.syncIndexes();
    expect(dropIndex.mock.calls).toContainEqual(["atscript__plain__pf_author_name"]);
  });
});
