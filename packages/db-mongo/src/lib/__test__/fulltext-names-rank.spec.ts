import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";

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
    expect(lastPipeline()).toContainEqual({ $sort: { _score: -1, _id: 1 } });
  });

  it("searchWithCount ranks its page the same way", async () => {
    aggregate = vi.fn(() => ({ toArray: async () => [{ data: [], meta: [] }] }));
    vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);
    await adapter.searchWithCount("cat", EMPTY_QUERY);
    const facet = lastPipeline().find((s) => "$facet" in s) as any;
    expect(facet.$facet.data).toContainEqual({ $sort: { _score: -1, _id: 1 } });
  });
});
