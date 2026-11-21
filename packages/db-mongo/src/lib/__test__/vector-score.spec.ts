import { describe, it, expect, beforeAll, afterEach, vi } from "vite-plus/test";
import { UniquSelect } from "@atscript/db";

import type { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Since 0.1.183 every vector row carries `$score` = Atlas `vectorSearchScore`,
// with or without a threshold (before, only `_score`, and only with a
// threshold). A `$`-name cannot come out of `$addFields`, so the score rides
// in `__atscript_score` and is renamed after fetch, as geo's `$distance` is.
// `_score` and the threshold `$match` are unchanged. Atlas Vector Search does
// not run on a local MongoDB: these tests pin the pipeline and the row mapping.

const mongo = createTestSpace();
const SCORE = { $meta: "vectorSearchScore" };
const VEC = Array.from({ length: 512 }, () => 0);
const ALL = ["_id", "title", "embedding"];

let fx: { cap: any };
let aggregate: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await prepareFixtures();
  fx = { cap: await import("./fixtures/search-capability.as") };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mocked(rows: unknown[]): MongoAdapter {
  mongo.getTable(fx.cap.CapVector).getMetadata();
  const adapter = mongo.getAdapter(fx.cap.CapVector) as unknown as MongoAdapter;
  aggregate = vi.fn(() => ({ toArray: async () => structuredClone(rows) }));
  vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);
  return adapter;
}

const pipeline = () => aggregate.mock.calls.at(-1)?.[0] as Array<Record<string, any>>;

describe("[mongo] vector $score (since 0.1.183)", () => {
  it("without a threshold: the score is read right after $vectorSearch and renamed to $score", async () => {
    const adapter = mocked([{ _id: "a", title: "x", __atscript_score: 0.8 }]);
    const rows = await adapter.vectorSearch(VEC, { filter: {}, controls: {} });
    expect(pipeline()[1]).toEqual({ $addFields: { __atscript_score: SCORE } });
    expect(pipeline()).not.toContainEqual({ $match: { _score: expect.anything() } });
    expect(rows).toEqual([{ _id: "a", title: "x", $score: 0.8 }]);
  });

  it("with a threshold: _score and its $match stay, $score is added", async () => {
    const adapter = mocked([{ _id: "a", title: "x", _score: 0.9, __atscript_score: 0.9 }]);
    const rows = await adapter.vectorSearch(VEC, { filter: {}, controls: { $threshold: 0.7 } });
    expect(pipeline().slice(1, 3)).toEqual([
      { $addFields: { _score: SCORE, __atscript_score: SCORE } },
      { $match: { _score: { $gte: 0.7 } } },
    ]);
    expect(rows).toEqual([{ _id: "a", title: "x", _score: 0.9, $score: 0.9 }]);
  });

  it("$select keeps the score: inclusion projects it, exclusion leaves it", async () => {
    const adapter = mocked([{ title: "x", __atscript_score: 0.5 }]);
    const included = await adapter.vectorSearch(VEC, {
      filter: {},
      controls: { $select: new UniquSelect(["title"], ALL) },
    });
    expect(pipeline().at(-1)).toEqual({ $project: { title: 1, __atscript_score: 1 } });
    expect(included).toEqual([{ title: "x", $score: 0.5 }]);

    await adapter.vectorSearch(VEC, {
      filter: {},
      controls: { $select: new UniquSelect({ embedding: 0 }, ALL) },
    });
    expect(pipeline().at(-1)).toEqual({ $project: { embedding: 0 } });
  });

  it("vectorSearchWithCount: the score is read before the $facet and renamed in its rows", async () => {
    const adapter = mocked([
      { data: [{ _id: "a", title: "x", __atscript_score: 0.6 }], meta: [{ count: 4 }] },
    ]);
    const result = await adapter.vectorSearchWithCount(VEC, {
      filter: {},
      controls: { $select: new UniquSelect(["title"], ALL) },
    });
    const stages = pipeline();
    expect(stages[1]).toEqual({ $addFields: { __atscript_score: SCORE } });
    expect(stages.at(-1)!.$facet.data).toContainEqual({
      $project: { title: 1, __atscript_score: 1 },
    });
    expect(result).toEqual({ data: [{ _id: "a", title: "x", $score: 0.6 }], count: 4 });
  });

  it("the table's vectorSearch returns $score through the read path", async () => {
    mocked([{ _id: "a", title: "x", __atscript_score: 0.75 }]);
    const table = mongo.getTable(fx.cap.CapVector);
    const rows = await table.vectorSearch(VEC, { controls: { $select: ["title"] } } as never);
    expect(rows).toEqual([{ _id: "a", title: "x", $score: 0.75 }]);
  });
});
