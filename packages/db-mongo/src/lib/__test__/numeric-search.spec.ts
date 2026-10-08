import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";

import type { DbQuery } from "@atscript/db";
import { MongoAdapter } from "../mongo-adapter";
import { buildMongoFilter } from "../mongo-filter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Integer members of a fulltext index (since 0.1.150): never part of the text
// index; matched by exact number when the whole term is a whole number —
// classic `$or` next to `$text` (index-backed, `$type`-guarded), Atlas `equals`.

const mongo = createTestSpace();

beforeAll(prepareFixtures);

let aggregate: ReturnType<typeof vi.fn>;
const EMPTY_QUERY: DbQuery = { filter: {}, controls: {} };

async function adapterOf(name: string): Promise<MongoAdapter> {
  const fx = await import("./fixtures/numeric-search.as");
  return mongo.getAdapter((fx as Record<string, any>)[name]) as unknown as MongoAdapter;
}

function mockAggregate(adapter: MongoAdapter) {
  aggregate = vi.fn(() => ({ toArray: async () => [] }));
  vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);
}

const firstStage = () => (aggregate.mock.calls.at(-1)![0] as Record<string, unknown>[])[0]!;
const pipeline = () => aggregate.mock.calls.at(-1)![0] as Record<string, unknown>[];

afterEach(() => vi.restoreAllMocks());

describe("[mongo] classic text index with integer members", () => {
  let adapter: MongoAdapter;
  beforeEach(async () => {
    adapter = await adapterOf("NsItem");
    mockAggregate(adapter);
  });

  it("a whole-number term adds an index-backed, $type-guarded equality next to $text", async () => {
    await adapter.search("2946", EMPTY_QUERY);
    expect(firstStage()).toEqual({
      $match: {
        $or: [
          { $text: { $search: "2946" } },
          { ref_no: { $eq: 2946, $type: "number" } },
          { alt_no: { $eq: 2946, $type: "number" } },
        ],
      },
    });
    // textScore stays valid; equality-only rows have no score and sort last
    expect(pipeline()).toContainEqual({ $addFields: { _score: { $meta: "textScore" } } });
  });

  it("a non-integer term is the plain $text match", async () => {
    await adapter.search("quokka", EMPTY_QUERY);
    expect(firstStage()).toEqual({ $match: { $text: { $search: "quokka" } } });
    await adapter.search("02946", EMPTY_QUERY);
    expect(firstStage()).toEqual({ $match: { $text: { $search: "02946" } } });
  });

  it("searchWithCount and the grouped aggregate share the stage", async () => {
    await adapter.searchWithCount("7", EMPTY_QUERY);
    expect(JSON.stringify(firstStage())).toContain('"ref_no":{"$eq":7,"$type":"number"}');
    aggregate.mockClear();
    await adapter.aggregate({
      filter: {},
      controls: { $groupBy: ["title"], $count: true, $search: "7" },
    } as any);
    expect(JSON.stringify(firstStage())).toContain('"alt_no":{"$eq":7,"$type":"number"}');
  });

  it("the text index definition excludes integer members", async () => {
    const index = adapter.getMongoSearchIndex()!;
    expect(index.type).toBe("text");
    expect(Object.keys((index as any).fields)).toEqual(["title"]);
    expect(adapter.getNumericSearchKeys()).toEqual(["ref_no", "alt_no"]);
    // the logical field list (visibility gate) still names the integer members
    expect(adapter.getSearchIndexes()[0]!.fields).toEqual(["title", "ref_no", "alt_no"]);
  });

  it("syncs a text index over the text members only", async () => {
    const col = {
      listIndexes: () => ({ toArray: async () => [] }),
      createIndex: vi.fn(async () => "ok"),
      dropIndex: vi.fn(async () => undefined),
      listSearchIndexes: () => ({ toArray: async () => [] }),
    };
    vi.spyOn(adapter, "collection", "get").mockReturnValue(col as never);
    vi.spyOn(adapter, "ensureCollectionExists").mockResolvedValue(undefined);
    await adapter.syncIndexes();
    const text = (col.createIndex.mock.calls as unknown as Array<[any, any]>).find(
      (c) => c[0] && Object.values(c[0]).includes("text"),
    )!;
    expect(text[0]).toEqual({ title: "text" });
    expect(text[1].weights).toEqual({ title: 1 });
  });
});

describe("[mongo] integer-only fulltext index", () => {
  let adapter: MongoAdapter;
  beforeEach(async () => {
    adapter = await adapterOf("NsCode");
    mockAggregate(adapter);
  });

  it("matches by number without $text (no textScore), and nothing for other terms", async () => {
    expect(adapter.isSearchable()).toBe(true);
    await adapter.search("4", EMPTY_QUERY);
    expect(firstStage()).toEqual({ $match: { id: { $eq: 4, $type: "number" } } });
    expect(JSON.stringify(pipeline())).not.toContain("textScore");
    await adapter.search("abc", EMPTY_QUERY);
    expect(firstStage()).toEqual({ $match: { _id: { $in: [] } } });
  });

  it("creates no text index and drops a stale one", async () => {
    const stale = {
      name: "atscript__fulltext__ns_codes_ft",
      key: { _fts: "text", _ftsx: 1 },
      weights: { label: 1 },
    };
    const col = {
      listIndexes: () => ({ toArray: async () => [stale] }),
      createIndex: vi.fn(async () => "ok"),
      dropIndex: vi.fn(async () => undefined),
      listSearchIndexes: () => ({ toArray: async () => [] }),
    };
    vi.spyOn(adapter, "collection", "get").mockReturnValue(col as never);
    vi.spyOn(adapter, "ensureCollectionExists").mockResolvedValue(undefined);
    await adapter.syncIndexes();
    const created = (col.createIndex.mock.calls as unknown as Array<[any, any]>).filter(
      (c) => c[1]?.name === "atscript__fulltext__ns_codes_ft",
    );
    expect(created).toEqual([]);
    expect(col.dropIndex).toHaveBeenCalledWith("atscript__fulltext__ns_codes_ft");
  });
});

describe("[mongo] Atlas search with integer members", () => {
  it("a static index maps the member as a number and ORs an equals clause", async () => {
    const adapter = await adapterOf("NsAtlas");
    mockAggregate(adapter);
    const index = adapter.getMongoSearchIndex("ns_atlas") as any;
    expect(index.definition.mappings.fields.ref_no).toEqual({ type: "number" });
    expect(index.paths).toContain("ref_no");
    await adapter.search("2946", EMPTY_QUERY, "ns_atlas");
    expect(firstStage()).toEqual({
      $search: {
        index: "atscript__search_text__ns_atlas",
        compound: {
          should: [
            { text: { query: "2946", path: { wildcard: "*" } } },
            { equals: { path: "ref_no", value: 2946 } },
          ],
          minimumShouldMatch: 1,
        },
      },
    });
  });

  it("a text-only term keeps the lone text clause", async () => {
    const adapter = await adapterOf("NsAtlas");
    mockAggregate(adapter);
    await adapter.search("quokka", EMPTY_QUERY, "ns_atlas");
    expect(firstStage()).toEqual({
      $search: {
        index: "atscript__search_text__ns_atlas",
        text: { query: "quokka", path: { wildcard: "*" } },
      },
    });
  });

  it("a dynamic index adds the equals clause too", async () => {
    const adapter = await adapterOf("NsAtlasDynamic");
    mockAggregate(adapter);
    await adapter.search("12", EMPTY_QUERY);
    expect(JSON.stringify(firstStage())).toContain('{"equals":{"path":"ref_no","value":12}}');
  });
});

describe("[mongo] $integerRegex filter", () => {
  it("renders a regex over the long-converted decimal text", () => {
    const f = buildMongoFilter({ ref_no: { $integerRegex: "^29" } } as never);
    expect(f).toEqual({
      $expr: {
        $regexMatch: {
          input: {
            $toString: {
              $convert: { input: "$ref_no", to: "long", onError: null, onNull: null },
            },
          },
          regex: "^29",
        },
      },
    });
  });

  it("keeps the i/m/s/x flags only", () => {
    const f = buildMongoFilter({ n: { $integerRegex: /a/gi } } as never) as any;
    expect(f.$expr.$regexMatch.options).toBe("i");
  });
});
