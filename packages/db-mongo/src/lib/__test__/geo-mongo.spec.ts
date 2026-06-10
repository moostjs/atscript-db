import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";

import type { DbQuery, TDbFieldMeta } from "@atscript/db";
import { MongoAdapter } from "../mongo-adapter";
import { buildMongoFilter } from "../mongo-filter";
import { createTestSpace, prepareFixtures } from "./test-utils";

const mongo = createTestSpace();

beforeAll(prepareFixtures);

let table: any;
let adapter: MongoAdapter;
let aggregate: ReturnType<typeof vi.fn>;
let createIndex: ReturnType<typeof vi.fn>;
let listIndexes: ReturnType<typeof vi.fn>;
let dropIndex: ReturnType<typeof vi.fn>;

function mockCollection(opts?: { rows?: unknown[]; existingIndexes?: unknown[] }) {
  aggregate = vi.fn(() => ({ toArray: async () => opts?.rows ?? [] }));
  createIndex = vi.fn(async () => "ok");
  dropIndex = vi.fn(async () => undefined);
  listIndexes = vi.fn(() => ({ toArray: async () => opts?.existingIndexes ?? [] }));
  const listSearchIndexes = vi.fn(() => ({
    toArray: async () => {
      throw new Error("not atlas");
    },
  }));
  vi.spyOn(adapter, "collection", "get").mockReturnValue({
    aggregate,
    createIndex,
    dropIndex,
    listIndexes,
    listSearchIndexes,
  } as never);
  vi.spyOn(adapter, "ensureCollectionExists").mockResolvedValue();
}

function lastPipeline(): Record<string, any>[] {
  return aggregate.mock.calls.at(-1)?.[0] as Record<string, any>[];
}

const EMPTY_QUERY: DbQuery = { filter: {}, controls: {} };

beforeEach(async () => {
  const { GeoListing } = await import("./fixtures/geo-collection.as");
  table = mongo.getTable(GeoListing);
  adapter = mongo.getAdapter(GeoListing) as unknown as MongoAdapter;
  table.getMetadata();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[mongo] geoPoint storage mapping (formatValue)", () => {
  it("wraps [lng, lat] tuples into GeoJSON Points on the write path", () => {
    const fd = table.fieldDescriptors.find((f: TDbFieldMeta) => f.path === "geo")!;
    const pair = adapter.formatValue(fd)!;
    expect(pair.toStorage([-122.42, 37.77])).toEqual({
      type: "Point",
      coordinates: [-122.42, 37.77],
    });
    // Non-tuple values (e.g. $geoWithin operator objects) pass through.
    const circle = { center: [0, 0], radius: 10 };
    expect(pair.toStorage(circle)).toBe(circle);
  });

  it("unwraps GeoJSON Points back to tuples on the read path", () => {
    const fd = table.fieldDescriptors.find((f: TDbFieldMeta) => f.path === "geo")!;
    const pair = adapter.formatValue(fd)!;
    expect(pair.fromStorage({ type: "Point", coordinates: [1, 2] })).toEqual([1, 2]);
    expect(pair.fromStorage("not-geo")).toBe("not-geo");
  });

  it("returns no formatter for non-geo fields", () => {
    const fd = table.fieldDescriptors.find((f: TDbFieldMeta) => f.path === "status")!;
    expect(adapter.formatValue(fd)).toBeUndefined();
  });
});

describe("[mongo] geoSearch pipeline ($geoNear first)", () => {
  it("emits $geoNear as the FIRST stage with the filter absorbed in `query`", async () => {
    mockCollection();
    await adapter.geoSearch([-122.42, 37.77], {
      filter: { status: "ACTIVE" },
      controls: { $maxDistance: 50_000, $minDistance: 10, $limit: 20 } as any,
    });

    const pipeline = lastPipeline();
    const geoNear = pipeline[0]!.$geoNear;
    expect(geoNear).toBeDefined();
    expect(geoNear.near).toEqual({ type: "Point", coordinates: [-122.42, 37.77] });
    expect(geoNear.spherical).toBe(true);
    expect(geoNear.key).toBe("geo");
    expect(geoNear.maxDistance).toBe(50_000);
    expect(geoNear.minDistance).toBe(10);
    expect(geoNear.query).toEqual({ status: "ACTIVE" });
    // No separate $match stage — the filter rides inside $geoNear.
    expect(pipeline.some((s) => "$match" in s)).toBe(false);
    expect(pipeline.at(-1)).toEqual({ $limit: 20 });
  });

  it("renames the internal distance field to $distance on returned rows", async () => {
    mockCollection({ rows: [{ id: "a", __atscript_distance: 1234.5 }] });
    const rows = await adapter.geoSearch([0, 0], EMPTY_QUERY);
    expect(rows[0]).toEqual({ id: "a", $distance: 1234.5 });
  });

  it("keeps the distance field in inclusion-mode projections", async () => {
    mockCollection();
    const { UniquSelect } = await import("@atscript/db");
    await adapter.geoSearch([0, 0], {
      filter: {},
      controls: { $select: new UniquSelect(["status"], ["status", "geo", "name"]) },
    });
    const project = lastPipeline().find((s) => "$project" in s)!.$project;
    expect(project.__atscript_distance).toBe(1);
    expect(project.status).toBe(1);
  });

  it("geoSearchWithCount runs a $facet after $geoNear", async () => {
    mockCollection({
      rows: [{ data: [{ id: "a", __atscript_distance: 5 }], meta: [{ count: 7 }] }],
    });
    const result = await adapter.geoSearchWithCount([0, 0], EMPTY_QUERY);
    const pipeline = lastPipeline();
    expect("$geoNear" in pipeline[0]!).toBe(true);
    expect("$facet" in pipeline[1]!).toBe(true);
    expect(result.count).toBe(7);
    expect(result.data[0]!.$distance).toBe(5);
  });

  it("reports geo capability", () => {
    expect(adapter.isGeoSearchable()).toBe(true);
  });
});

describe("[mongo] $geoWithin filter translation", () => {
  it("translates the circle into $centerSphere radians", () => {
    const filter = buildMongoFilter({
      geo: { $geoWithin: { center: [-122.42, 37.77], radius: 6378.1 } },
    } as any);
    expect(filter).toEqual({
      geo: { $geoWithin: { $centerSphere: [[-122.42, 37.77], 6378.1 / 6_378_100] } },
    });
  });
});

describe("[mongo] 2dsphere index sync (atscript__ managed prefix)", () => {
  it("creates the managed 2dsphere index", async () => {
    mockCollection();
    await adapter.syncIndexes();
    const call = createIndex.mock.calls.find((c) => c[0]?.geo === "2dsphere");
    expect(call).toBeDefined();
    expect(call![1]).toEqual({ name: "atscript__geo__geo" });
  });

  it("keeps an in-sync 2dsphere index (idempotent re-sync)", async () => {
    mockCollection({
      existingIndexes: [{ name: "atscript__geo__geo", key: { geo: "2dsphere" } }],
    });
    await adapter.syncIndexes();
    expect(dropIndex).not.toHaveBeenCalled();
    expect(createIndex.mock.calls.some((c) => c[0]?.geo === "2dsphere")).toBe(false);
  });

  it("drift-corrects a managed index pointing at the wrong field", async () => {
    mockCollection({
      existingIndexes: [{ name: "atscript__geo__geo", key: { wrongField: "2dsphere" } }],
    });
    await adapter.syncIndexes();
    expect(dropIndex).toHaveBeenCalledWith("atscript__geo__geo");
    expect(createIndex.mock.calls.some((c) => c[0]?.geo === "2dsphere")).toBe(true);
  });
});

describe("[mongo] @db.encrypted veto", () => {
  it("canFilterField respects the encrypted flag despite Mongo's permissive override", async () => {
    const { randomBytes } = await import("node:crypto");
    const { DbSpace } = await import("@atscript/db");
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient("mongodb+srv://dummy:dummy@test.jd1qx.mongodb.net/test?");
    const encSpace = new DbSpace(() => new MongoAdapter(client.db(), client), {
      encryption: { defaultKeyId: "k1", keys: { k1: randomBytes(32) } },
    });
    const { EncSecret } = await import("./fixtures/geo-collection.as");
    const encTable = encSpace.getTable(EncSecret);
    const encAdapter = encSpace.getAdapter(EncSecret) as unknown as MongoAdapter;
    const encFd = encTable.fieldDescriptors.find((f: TDbFieldMeta) => f.path === "apiToken")!;
    const plainFd = encTable.fieldDescriptors.find((f: TDbFieldMeta) => f.path === "label")!;
    expect(encAdapter.canFilterField(encFd)).toBe(false);
    expect(encAdapter.canFilterField(plainFd)).toBe(true);
  });
});
