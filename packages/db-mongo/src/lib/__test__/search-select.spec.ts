import { describe, it, expect, beforeAll, afterEach, vi } from "vite-plus/test";
import { UniquSelect } from "@atscript/db";

import type { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Geo and vector search project `$select` like findMany — inclusion AND
// exclusion forms (the write-only seal HTTP layers pass is an exclusion
// projection), on both the plain and the `WithCount` ($facet) pipelines.
// Regression pins for 0.1.143 (the SQL adapters ignored `$select` there).

const mongo = createTestSpace();

let fx: { geo: any; cap: any };
let aggregate: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await prepareFixtures();
  fx = {
    geo: await import("./fixtures/geo-collection.as"),
    cap: await import("./fixtures/search-capability.as"),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mocked(type: any, rows: unknown[] = []): MongoAdapter {
  mongo.getTable(type).getMetadata();
  const adapter = mongo.getAdapter(type) as unknown as MongoAdapter;
  aggregate = vi.fn(() => ({ toArray: async () => rows }));
  vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);
  return adapter;
}

/** Every `$project` stage of the last pipeline, `$facet` data stages included. */
function projections(): Array<Record<string, unknown>> {
  const pipeline = aggregate.mock.calls.at(-1)?.[0] as Array<Record<string, any>>;
  const stages = pipeline.flatMap((s) => (s.$facet ? s.$facet.data : [s]));
  return stages.filter((s) => "$project" in s).map((s) => s.$project);
}

const exclusion = () => new UniquSelect({ name: 0 }, ["_id", "status", "geo", "name"]);

describe("[mongo] geoSearch / vectorSearch $select", () => {
  it("geoSearch applies an exclusion projection", async () => {
    const adapter = mocked(fx.geo.GeoListing);
    await adapter.geoSearch([0, 0], { filter: {}, controls: { $select: exclusion() } });
    expect(projections()).toEqual([{ name: 0 }]);
  });

  it("geoSearchWithCount applies the projection inside $facet.data", async () => {
    const adapter = mocked(fx.geo.GeoListing, [{ data: [], meta: [] }]);
    await adapter.geoSearchWithCount([0, 0], { filter: {}, controls: { $select: exclusion() } });
    expect(projections()).toEqual([{ name: 0 }]);
  });

  it("vectorSearch / vectorSearchWithCount apply inclusion and exclusion projections", async () => {
    const adapter = mocked(fx.cap.CapVector);
    const vec = Array.from({ length: 512 }, () => 0);
    const all = ["_id", "title", "embedding"];
    await adapter.vectorSearch(vec, {
      filter: {},
      controls: { $select: new UniquSelect(["title"], all) },
    });
    expect(projections()).toEqual([{ title: 1 }]);

    aggregate.mockImplementation(() => ({ toArray: async () => [{ data: [], meta: [] }] }));
    await adapter.vectorSearchWithCount(vec, {
      filter: {},
      controls: { $select: new UniquSelect({ embedding: 0 }, all) },
    });
    expect(projections()).toEqual([{ embedding: 0 }]);
  });
});
