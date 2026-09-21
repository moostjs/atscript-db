import { AtscriptDbTable, DbSpace, UniquSelect } from "@atscript/db";
import type { DbQuery } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// A grouped query (`$groupBy`) that also carries a `$search` term used to drop
// the term on the floor: `$search` arrived in `query.controls` and the pipeline
// builder never looked at it, so the leaf list was filtered by the search while
// the rollup and its `$count` described the WHOLE collection. Same request, two
// populations, no error.
//
// The contract (normative docblock: `resolveAggregateSearch` in
// `@atscript/db/agg`): the search stage applies BEFORE `$group`, with NO
// implicit relevance ordering and NO implicit row cap — both are leaf-only
// rules that would be wrong (or silently truncating) in front of `$group`.

const mongo = createTestSpace();

beforeAll(prepareFixtures);

let adapter: MongoAdapter;
let aggregate: ReturnType<typeof vi.fn>;

/** Mocks the collection so aggregate() is captured instead of hitting a DB. */
function mockCollection() {
  aggregate = vi.fn(() => ({ toArray: async () => [] }));
  vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);
}

/** The pipeline passed to the most recent aggregate() call. */
function lastPipeline(): Record<string, any>[] {
  return aggregate.mock.calls.at(-1)?.[0] as Record<string, any>[];
}

/** Builds an adapter-level (already translated) grouped DbQuery. */
function groupedQuery(controls: Record<string, unknown>): DbQuery {
  return {
    filter: (controls.filter as Record<string, unknown>) ?? {},
    controls: {
      $groupBy: ["category"],
      ...controls,
      $select: controls.$select ? new UniquSelect(controls.$select as any) : undefined,
    } as DbQuery["controls"],
  };
}

const COUNT_SELECT = ["category", { $fn: "count", $field: "*", $as: "cnt" }];

/** Groups leaf `search()` rows by category in-test — the expected rollup. */
function groupLeaf(rows: Array<Record<string, any>>): Array<{ category: string; cnt: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, cnt]) => ({ category, cnt }))
    .toSorted((a, b) => a.category.localeCompare(b.category));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[mongo] grouped $search — classic $text pipeline shape", () => {
  beforeEach(async () => {
    const { Article } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(Article) as unknown as MongoAdapter;
    mockCollection();
  });

  it("puts the classic $text $match FIRST, ahead of the filter $match", async () => {
    await adapter.aggregate(
      groupedQuery({ filter: { category: "tools" }, $select: COUNT_SELECT, $search: "widget" }),
    );

    expect(lastPipeline()).toEqual([
      { $match: { $text: { $search: "widget" } } },
      { $match: { category: "tools" } },
      { $group: { _id: { category: "$category" }, cnt: { $sum: 1 } } },
      { $project: { _id: 0, category: "$_id.category", cnt: 1 } },
    ]);
  });

  it("$count carries the same leading search stage", async () => {
    aggregate = vi.fn(() => ({ toArray: async () => [{ count: 2 }] }));
    vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);

    await adapter.aggregate(groupedQuery({ $search: "widget", $count: true }));

    expect(lastPipeline()).toEqual([
      { $match: { $text: { $search: "widget" } } },
      { $match: {} },
      { $group: { _id: { category: "$category" } } },
      { $count: "count" },
    ]);
  });

  it("the count pipeline equals the row pipeline up to $count ($search + $having)", async () => {
    const controls = {
      $select: COUNT_SELECT,
      $search: "widget",
      $having: { cnt: { $gt: 1 } },
    };
    await adapter.aggregate(groupedQuery({ ...controls, $sort: { cnt: -1 }, $limit: 5 }));
    const rows = lastPipeline();

    aggregate = vi.fn(() => ({ toArray: async () => [{ count: 1 }] }));
    vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);
    await adapter.aggregate(groupedQuery({ ...controls, $count: true }));
    const count = lastPipeline();

    expect(count.slice(0, -1)).toEqual(rows.slice(0, count.length - 1));
    expect(count.at(-1)).toEqual({ $count: "count" });
    expect(rows.slice(count.length - 1)).toEqual([{ $sort: { cnt: -1 } }, { $limit: 5 }]);
  });

  it("adds no relevance $sort, no default $limit and no _score projection", async () => {
    await adapter.aggregate(groupedQuery({ $select: COUNT_SELECT, $search: "widget" }));

    const pipeline = lastPipeline();
    expect(pipeline).not.toContainEqual({ $sort: { _score: -1 } });
    expect(pipeline).not.toContainEqual({ $limit: 1000 });
    expect(pipeline.some((s) => "$sort" in s || "$limit" in s)).toBe(false);
    // A $limit before $group would silently truncate group counts; a _score
    // $addFields would have nothing to survive into the grouped rows anyway.
    expect(JSON.stringify(pipeline)).not.toContain("_score");
    expect(JSON.stringify(pipeline)).not.toContain("textScore");
  });

  it("a blank / absent $search leaves the pipelines byte-identical to today", async () => {
    await adapter.aggregate(groupedQuery({ $select: COUNT_SELECT }));
    const plain = lastPipeline();

    for (const blank of ["", "   ", undefined]) {
      await adapter.aggregate(groupedQuery({ $select: COUNT_SELECT, $search: blank }));
      expect(lastPipeline()).toEqual(plain);
    }
    expect(plain[0]).toEqual({ $match: {} });
  });

  it("an unresolvable $index throws, exactly as the leaf search path does", async () => {
    await expect(
      adapter.aggregate(groupedQuery({ $search: "widget", $index: "nope" })),
    ).rejects.toThrow('Search index "nope" not found');
  });
});

describe("[mongo] grouped $search — Atlas $search pipeline shape", () => {
  it("emits the Atlas $search stage FIRST, with no $text anywhere", async () => {
    const { SearchDoc } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(SearchDoc) as unknown as MongoAdapter;
    mockCollection();

    await adapter.aggregate({
      filter: { title: { $ne: null } },
      controls: {
        $groupBy: ["title"],
        $select: new UniquSelect(["title", { $fn: "count", $field: "*", $as: "cnt" }] as any),
        $search: "hello",
      } as DbQuery["controls"],
    });

    const pipeline = lastPipeline();
    expect(pipeline[0]).toHaveProperty("$search");
    expect(pipeline[0].$search.text).toEqual({ query: "hello", path: { wildcard: "*" } });
    expect(pipeline[1]).toEqual({ $match: { title: { $ne: null } } });
    expect(pipeline[2]).toHaveProperty("$group");
    expect(JSON.stringify(pipeline)).not.toContain("$text");
  });

  it("$index picks the named Atlas index, same rules as search()", async () => {
    const { Member } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(Member) as unknown as MongoAdapter;
    mockCollection();

    await adapter.aggregate({
      filter: {},
      controls: {
        $groupBy: ["username"],
        $search: "art",
        $index: "members_prefix",
        $count: true,
      } as DbQuery["controls"],
    });

    const prefixKey = (adapter.getMongoSearchIndex("members_prefix") as any).key;
    const pipeline = lastPipeline();
    expect(pipeline[0].$search.index).toBe(prefixKey);
    // The prefix index declares fuzzy — the grouped path resolves the stage
    // through the very same builder, so it is carried here too.
    expect(pipeline[0].$search.compound.should).toContainEqual({
      autocomplete: { query: "art", path: "username", fuzzy: { maxEdits: 1 } },
    });
    expect(pipeline.at(-1)).toEqual({ $count: "count" });
  });
});

/**
 * Live parity against a real mongod: the grouped rollup must describe EXACTLY
 * the documents the leaf `search()` returns — the assertion the defect failed.
 * Classic `$text` runs fully in-process (Atlas `$search` cannot).
 */
describe("[mongo e2e] grouped $search matches the leaf search population", () => {
  let server: any;
  let client: MongoClient;
  let db: Db;
  let articles: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    const { Article } = await import("./fixtures/search-collection.as");

    const { MongoMemoryServer } = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server = await MongoMemoryServer.create();
    client = new MC(server.getUri());
    await client.connect();
    db = client.db("test");
    articles = new DbSpace(() => new MongoAdapter(db, client)).getTable(Article);

    // Creates the classic MongoDB text index on title + body.
    await articles.syncIndexes();

    await articles.insertMany([
      { id: 1, title: "alpha widget", body: "blue", category: "tools" },
      { id: 2, title: "beta widget", body: "blue", category: "tools" },
      { id: 3, title: "gamma gadget", body: "red", category: "tools" },
      { id: 4, title: "delta widget", body: "blue", category: "toys" },
      { id: 5, title: "epsilon gadget", body: "red", category: "toys" },
    ] as any);
  }, 60_000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  const grouped = (controls: Record<string, unknown>) =>
    articles.aggregate({
      filter: {},
      controls: {
        $groupBy: ["category"],
        $select: ["category", { $fn: "count", $field: "*", $as: "cnt" }],
        $sort: { category: 1 },
        ...controls,
      } as any,
    });

  it("groups only the documents the search matched", async () => {
    const leaf = (await articles.search("widget", { controls: {} })) as Array<Record<string, any>>;
    expect(leaf.map((r) => r.id).toSorted((a, b) => a - b)).toEqual([1, 2, 4]);

    const rollup = await grouped({ $search: "widget" });
    expect(rollup).toEqual(groupLeaf(leaf));
    expect(rollup).toEqual([
      { category: "tools", cnt: 2 },
      { category: "toys", cnt: 1 },
    ]);

    // The defect's signature: without the term the same query counts everything.
    expect(await grouped({})).toEqual([
      { category: "tools", cnt: 3 },
      { category: "toys", cnt: 2 },
    ]);
  });

  it("drops a group entirely when the search excludes all of its rows", async () => {
    const leaf = (await articles.search("epsilon", { controls: {} })) as Array<Record<string, any>>;
    expect(leaf.map((r) => r.id)).toEqual([5]);

    expect(await grouped({ $search: "epsilon" })).toEqual(groupLeaf(leaf));
  });

  it("$count counts the groups over matching documents only", async () => {
    expect(await grouped({ $search: "widget", $count: true })).toEqual([{ count: 2 }]);
    expect(await grouped({ $search: "epsilon", $count: true })).toEqual([{ count: 1 }]);
    expect(await grouped({ $count: true })).toEqual([{ count: 2 }]);
    // A term nothing matches: zero groups, not "all of them".
    expect(await grouped({ $search: "zzzznomatch", $count: true })).toEqual([{ count: 0 }]);
  });

  it("$search composes with $having — and $count agrees with the rows", async () => {
    const rows = await grouped({ $search: "widget", $having: { cnt: { $gt: 1 } } });
    expect(rows).toEqual([{ category: "tools", cnt: 2 }]);

    expect(
      await grouped({ $search: "widget", $having: { cnt: { $gt: 1 } }, $count: true }),
    ).toEqual([{ count: 1 }]);
  });

  it("$search composes with the filter, $sort, $skip and $limit", async () => {
    expect(await grouped({ $search: "blue widget" })).toEqual([
      { category: "tools", cnt: 2 },
      { category: "toys", cnt: 1 },
    ]);

    expect(await grouped({ $search: "widget", $sort: { cnt: -1 }, $limit: 1 })).toEqual([
      { category: "tools", cnt: 2 },
    ]);
    expect(await grouped({ $search: "widget", $sort: { category: 1 }, $skip: 1 })).toEqual([
      { category: "toys", cnt: 1 },
    ]);

    // The filter narrows on top of the search, not instead of it.
    expect(
      await articles.aggregate({
        filter: { category: "tools" },
        controls: {
          $groupBy: ["category"],
          $select: ["category", { $fn: "count", $field: "*", $as: "cnt" }],
          $search: "widget",
        } as any,
      }),
    ).toEqual([{ category: "tools", cnt: 2 }]);
  });
});
