import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";

import { UniquSelect } from "@atscript/db";
import type { DbQuery } from "@atscript/db";
import type { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Since 0.1.165: the default `@db.index.fulltext` index is addressed and
// reported by its DECLARED name — before, it was reachable only as `DEFAULT`,
// which stays a deprecated alias. Relevance order gets `_id` as tie-breaker.

const mongo = createTestSpace();

let adapter: MongoAdapter;
let aggregate: ReturnType<typeof vi.fn>;

beforeAll(prepareFixtures);

beforeEach(async () => {
  const { FtPlain } = await import("./fixtures/fulltext-rank.as");
  adapter = mongo.getAdapter(FtPlain) as unknown as MongoAdapter;
  aggregate = vi.fn(() => ({ toArray: async () => [] }));
  vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const EMPTY_QUERY: DbQuery = { filter: {}, controls: {} };
const lastPipeline = () => aggregate.mock.calls.at(-1)?.[0] as Record<string, unknown>[];

describe("[mongo] fulltext index names", () => {
  it("getSearchIndexes reports the declared name, DEFAULT as an alias", () => {
    expect(adapter.getSearchIndexes().map((i) => [i.name, i.aliases, i.isDefault])).toEqual([
      ["ft_plain_idx", ["DEFAULT"], true],
    ]);
  });

  it("search() resolves the default index by its declared name", async () => {
    await adapter.search("cat", EMPTY_QUERY, "ft_plain_idx");
    expect(lastPipeline()[0]).toEqual({ $match: { $text: { $search: "cat" } } });
  });

  it("DEFAULT still resolves (deprecated alias)", async () => {
    await adapter.search("cat", EMPTY_QUERY, "DEFAULT");
    expect(lastPipeline()[0]).toEqual({ $match: { $text: { $search: "cat" } } });
  });

  it("an unknown name answers the shared not-found message", async () => {
    await expect(adapter.search("cat", EMPTY_QUERY, "nope")).rejects.toThrow(
      'Search index "nope" not found',
    );
  });
});

describe("[mongo] fulltext relevance order", () => {
  it("no $sort: textScore DESC, then _id", async () => {
    await adapter.search("cat", EMPTY_QUERY);
    expect(lastPipeline()).toContainEqual({ $sort: { __atscript_score: -1, _id: 1 } });
  });

  it("searchWithCount ranks its page the same way", async () => {
    aggregate = vi.fn(() => ({ toArray: async () => [{ data: [], meta: [] }] }));
    vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);
    await adapter.searchWithCount("cat", EMPTY_QUERY);
    const facet = lastPipeline().find((s) => "$facet" in s) as any;
    expect(facet.$facet.data).toContainEqual({ $sort: { __atscript_score: -1, _id: 1 } });
  });
});

// `$rank: false` (since 0.1.175): no textScore — `$sort`, else `_id` order.
const UNRANKED: DbQuery = { filter: {}, controls: { $rank: false } };
const noScore = (stages: Record<string, unknown>[]) =>
  expect(JSON.stringify(stages)).not.toMatch(/textScore|_score/);

describe("[mongo] $rank: false", () => {
  it("search(): no textScore, sorted by _id", async () => {
    await adapter.search("cat", UNRANKED);
    noScore(lastPipeline());
    expect(lastPipeline()).toContainEqual({ $sort: { _id: 1 } });
  });

  it("searchWithCount(): no textScore before the $facet, the page sorted by _id", async () => {
    aggregate = vi.fn(() => ({ toArray: async () => [{ data: [], meta: [] }] }));
    vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);
    await adapter.searchWithCount("cat", UNRANKED);
    noScore(lastPipeline());
    const facet = lastPipeline().find((s) => "$facet" in s) as any;
    expect(facet.$facet.data).toContainEqual({ $sort: { _id: 1 } });
  });

  it("an explicit $sort still wins", async () => {
    await adapter.search("cat", { filter: {}, controls: { $rank: false, $sort: { title: -1 } } });
    noScore(lastPipeline());
    expect(lastPipeline()).toContainEqual({ $sort: { title: -1 } });
    expect(lastPipeline()).not.toContainEqual({ $sort: { _id: 1 } });
  });
});

// Since 0.1.185 a classic text search row carries no score field (before, rows
// carried the `textScore` as `_score`, replacing a stored `_score`): the score
// is read into an internal field only for the relevance `$sort` and dropped
// after `$skip` / `$limit`, whatever the `$select`.
const TEXT_SCORE = { $addFields: { __atscript_score: { $meta: "textScore" } } };
const RELEVANCE = { $sort: { __atscript_score: -1, _id: 1 } };
const DROP_SCORE = { $project: { __atscript_score: 0 } };
const ALL = ["_id", "title", "body"];
const SELECTS = [
  ["no $select", undefined, []],
  ["an inclusion $select", () => new UniquSelect(["title"], ALL), [{ $project: { title: 1 } }]],
  ["an exclusion $select", () => new UniquSelect({ body: 0 }, ALL), [{ $project: { body: 0 } }]],
] as const;
const selectQuery = (select: (() => UniquSelect) | undefined): DbQuery => ({
  filter: {},
  controls: select ? { $select: select() } : {},
});
const mockFacet = (data: unknown[] = [], count = 0) =>
  aggregate.mockImplementation(() => ({ toArray: async () => [{ data, meta: [{ count }] }] }));

describe("[mongo] classic text rows carry no score field", () => {
  it.each(SELECTS)("search() with %s", async (_, select, projection) => {
    await adapter.search("cat", selectQuery(select));
    expect(lastPipeline()).toEqual([
      { $match: { $text: { $search: "cat" } } },
      { $match: {} },
      TEXT_SCORE,
      RELEVANCE,
      { $limit: 1000 },
      DROP_SCORE,
      ...projection,
    ]);
  });

  it.each(SELECTS)("searchWithCount() with %s", async (_, select, projection) => {
    mockFacet();
    await adapter.searchWithCount("cat", selectQuery(select));
    expect(lastPipeline()).toEqual([
      { $match: { $text: { $search: "cat" } } },
      { $match: {} },
      {
        $facet: {
          data: [TEXT_SCORE, RELEVANCE, DROP_SCORE, ...projection],
          meta: [{ $count: "count" }],
        },
      },
    ]);
  });

  it("$skip / $limit cut the page before the score is dropped", async () => {
    const query: DbQuery = { filter: {}, controls: { $skip: 20, $limit: 10 } };
    await adapter.search("cat", query);
    expect(lastPipeline().slice(-5)).toEqual([
      TEXT_SCORE,
      RELEVANCE,
      { $skip: 20 },
      { $limit: 10 },
      DROP_SCORE,
    ]);
    mockFacet();
    await adapter.searchWithCount("cat", query);
    const facet = lastPipeline().at(-1) as any;
    expect(facet.$facet.data).toEqual([
      TEXT_SCORE,
      RELEVANCE,
      { $skip: 20 },
      { $limit: 10 },
      DROP_SCORE,
    ]);
  });

  it("an explicit $sort reads no score in either runner", async () => {
    const sorted: DbQuery = { filter: {}, controls: { $sort: { title: 1 } } };
    await adapter.search("cat", sorted);
    noScore(lastPipeline());
    mockFacet();
    await adapter.searchWithCount("cat", sorted);
    noScore(lastPipeline());
    expect((lastPipeline().at(-1) as any).$facet.data).toEqual([{ $sort: { title: 1 } }]);
  });
});

describe("[mongo] a stored _score field after a classic text search", () => {
  const row = { _id: "a", title: "cat", _score: 42 };
  const internal = /textScore|__atscript_score/;

  it("comes back as stored — no stage writes it", async () => {
    aggregate.mockImplementation(() => ({ toArray: async () => [{ ...row }] }));
    expect(await adapter.search("cat", EMPTY_QUERY)).toEqual([row]);
    expect(JSON.stringify(lastPipeline())).not.toMatch(/"_score"/);
    mockFacet([{ ...row }], 1);
    expect(await adapter.searchWithCount("cat", EMPTY_QUERY)).toEqual({ data: [row], count: 1 });
    expect(JSON.stringify(lastPipeline())).not.toMatch(/"_score"/);
  });

  it("an explicit $sort on it sorts by the stored value", async () => {
    const query: DbQuery = { filter: {}, controls: { $sort: { _score: -1 } } };
    await adapter.search("cat", query);
    expect(lastPipeline()).toContainEqual({ $sort: { _score: -1 } });
    expect(JSON.stringify(lastPipeline())).not.toMatch(internal);
    mockFacet();
    await adapter.searchWithCount("cat", query);
    expect((lastPipeline().at(-1) as any).$facet.data).toEqual([{ $sort: { _score: -1 } }]);
    expect(JSON.stringify(lastPipeline())).not.toMatch(internal);
  });
});
