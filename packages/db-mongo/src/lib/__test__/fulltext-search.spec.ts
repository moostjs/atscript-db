import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";

import type { DbQuery } from "@atscript/db";
import { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// A table whose only text-search declaration is the portable `@db.index.fulltext`
// syncs to a CLASSIC MongoDB text index (createIndex, not createSearchIndex).
// search() MUST therefore execute via classic `$text` — NOT Atlas `$search`,
// which can only resolve mongot-backed Atlas Search indexes and is unsupported
// on community MongoDB. Before the fix, search() always emitted `$search`, so a
// fulltext-only table advertised `searchable: true` yet threw at runtime.

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
function lastPipeline(): Record<string, unknown>[] {
  const call = aggregate.mock.calls.at(-1);
  return call?.[0] as Record<string, unknown>[];
}

const EMPTY_QUERY: DbQuery = { filter: {}, controls: {} };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[mongo] @db.index.fulltext executes classic $text (not Atlas $search)", () => {
  beforeEach(async () => {
    const { Article } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(Article) as unknown as MongoAdapter;
    mockCollection();
  });

  it("advertises the fulltext index as a usable searchable text index", () => {
    expect(adapter.isSearchable()).toBe(true);
    const indexes = adapter.getSearchIndexes();
    expect(indexes.length).toBeGreaterThan(0);
    expect(indexes.some((i) => i.type === "text")).toBe(true);
  });

  it("search() emits a classic $text $match as the FIRST stage, never $search", async () => {
    await adapter.search("hello world", EMPTY_QUERY);

    const pipeline = lastPipeline();
    // $text must be the first stage (MongoDB requirement).
    expect(pipeline[0]).toEqual({ $match: { $text: { $search: "hello world" } } });
    // No Atlas $search anywhere — that path can't see a classic text index.
    expect(JSON.stringify(pipeline)).not.toContain('$search":{"index');
    expect(pipeline.some((s) => "$search" in s)).toBe(false);
  });

  it("search() defaults to relevance ordering via { $meta: 'textScore' }", async () => {
    await adapter.search("hello", EMPTY_QUERY);

    const pipeline = lastPipeline();
    expect(pipeline).toContainEqual({ $addFields: { _score: { $meta: "textScore" } } });
    expect(pipeline).toContainEqual({ $sort: { _score: -1 } });
  });

  it("search() honors a caller-supplied $sort instead of the relevance default", async () => {
    await adapter.search("hello", { filter: {}, controls: { $sort: { title: 1 } } } as DbQuery);

    const pipeline = lastPipeline();
    expect(pipeline).toContainEqual({ $sort: { title: 1 } });
    expect(pipeline).not.toContainEqual({ $sort: { _score: -1 } });
  });

  it("searchWithCount() uses $text + $facet and projects textScore BEFORE the facet", async () => {
    aggregate = vi.fn(() => ({ toArray: async () => [{ data: [], meta: [] }] }));
    vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);

    await adapter.searchWithCount("hello", EMPTY_QUERY);

    const pipeline = lastPipeline();
    expect(pipeline[0]).toEqual({ $match: { $text: { $search: "hello" } } });
    // textScore is not accessible inside $facet sub-pipelines — must be projected first.
    const facetIdx = pipeline.findIndex((s) => "$facet" in s);
    const scoreIdx = pipeline.findIndex(
      (s) =>
        JSON.stringify(s) === JSON.stringify({ $addFields: { _score: { $meta: "textScore" } } }),
    );
    expect(scoreIdx).toBeGreaterThanOrEqual(0);
    expect(scoreIdx).toBeLessThan(facetIdx);
  });
});

describe("[mongo] Atlas search declarations still route through $search (regression)", () => {
  beforeEach(async () => {
    const { SearchDoc } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(SearchDoc) as unknown as MongoAdapter;
    mockCollection();
  });

  it("search() emits an Atlas $search stage for @db.mongo.search.dynamic", async () => {
    await adapter.search("hello", EMPTY_QUERY);

    const pipeline = lastPipeline();
    expect(pipeline[0]).toHaveProperty("$search");
    expect(JSON.stringify(pipeline)).not.toContain("$text");
  });
});
