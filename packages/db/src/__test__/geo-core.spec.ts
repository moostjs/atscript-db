import { describe, it, expect, beforeAll } from "vite-plus/test";

import type { FilterExpr } from "@uniqu/core";

import { DbSpace } from "../table/db-space";
import { computeTableSnapshot } from "../schema/schema-hash";
import type { DbQuery } from "../types";
import { MockAdapter, prepareFixtures } from "./test-utils";

let GeoListing: any;
let GeoUnindexed: any;

/** MockAdapter with geo capability — records geoSearch delegations. */
class GeoMockAdapter extends MockAdapter {
  public geoCalls: Array<{ point: [number, number]; query: DbQuery; indexName?: string }> = [];

  override isGeoSearchable(): boolean {
    return true;
  }

  override async geoSearch(point: [number, number], query: DbQuery, indexName?: string) {
    this.geoCalls.push({ point, query, indexName });
    return [{ id: "a", status: "ACTIVE", geo: [1, 2], $distance: 42 }];
  }

  override async geoSearchWithCount(point: [number, number], query: DbQuery, indexName?: string) {
    return { data: await this.geoSearch(point, query, indexName), count: 1 };
  }
}

beforeAll(async () => {
  await prepareFixtures();
  ({ GeoListing, GeoUnindexed } = await import("./fixtures/geo-table.as"));
});

describe("db.geoPoint / @db.index.geo — metadata", () => {
  it("registers geo indexes with the atscript__geo__ key prefix", () => {
    const table = new DbSpace(() => new GeoMockAdapter()).getTable(GeoListing);
    const geoIndexes = [...table.indexes.values()].filter((i) => i.type === "geo");
    expect(geoIndexes).toHaveLength(2);
    const byName = new Map(geoIndexes.map((i) => [i.name, i]));
    expect(byName.get("geo")!.key).toBe("atscript__geo__geo");
    expect(byName.get("geo")!.fields[0]!.name).toBe("geo");
    expect(byName.get("second")!.fields[0]!.name).toBe("altGeo");
  });

  it("marks geoPoint descriptors and vetoes sorting", () => {
    const table = new DbSpace(() => new GeoMockAdapter()).getTable(GeoListing);
    const fd = table.fieldDescriptors.find((f) => f.path === "geo")!;
    expect(fd.isGeoPoint).toBe(true);
    expect(table.canSortField(fd)).toBe(false);
  });

  it("geo index participates in the table snapshot (hash drift on toggle)", () => {
    const table = new DbSpace(() => new GeoMockAdapter()).getTable(GeoListing);
    table.getMetadata();
    const snapshot = computeTableSnapshot(table as any);
    expect(snapshot.indexes.some((i) => i.type === "geo")).toBe(true);
  });
});

describe("db.geoPoint — write validation", () => {
  it.each([
    ["longitude out of range", [200, 0]],
    ["latitude out of range", [0, 99]],
    ["wrong length", [1, 2, 3]],
    ["non-finite", [Number.NaN, 0]],
    ["not an array", "1,2"],
  ])("rejects %s on insert", async (_label, geo) => {
    const table = new DbSpace(() => new GeoMockAdapter()).getTable(GeoListing);
    await expect(table.insertOne({ id: "x", status: "A", geo })).rejects.toThrow();
  });

  it("accepts a valid [lng, lat] tuple", async () => {
    const table = new DbSpace(() => new GeoMockAdapter()).getTable(GeoListing);
    await expect(
      table.insertOne({ id: "ok", status: "A", geo: [-122.42, 37.77] }),
    ).resolves.toBeDefined();
  });
});

describe("geoSearch — core contract", () => {
  it("throws GEO_NOT_SUPPORTED on adapters without geo support", async () => {
    const table = new DbSpace(() => new MockAdapter()).getTable(GeoListing);
    await expect(table.geoSearch([0, 0])).rejects.toMatchObject({ code: "GEO_NOT_SUPPORTED" });
    expect(table.isGeoSearchable()).toBe(false);
  });

  it("throws GEO_INDEX_MISSING on a table without a geo index", async () => {
    const table = new DbSpace(() => new GeoMockAdapter()).getTable(GeoUnindexed);
    await expect(table.geoSearch([0, 0])).rejects.toMatchObject({ code: "GEO_INDEX_MISSING" });
  });

  it("throws GEO_INDEX_MISSING for an unknown index name", async () => {
    const table = new DbSpace(() => new GeoMockAdapter()).getTable(GeoListing);
    await expect(table.geoSearch("nope", [0, 0])).rejects.toMatchObject({
      code: "GEO_INDEX_MISSING",
    });
  });

  it("validates the query point", async () => {
    const table = new DbSpace(() => new GeoMockAdapter()).getTable(GeoListing);
    await expect(table.geoSearch([200, 0] as any)).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  it("rejects user $sort (results are distance-ordered)", async () => {
    const table = new DbSpace(() => new GeoMockAdapter()).getTable(GeoListing);
    await expect(
      table.geoSearch([0, 0], { filter: {}, controls: { $sort: { status: 1 } } }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("validates $maxDistance / $minDistance", async () => {
    const table = new DbSpace(() => new GeoMockAdapter()).getTable(GeoListing);
    await expect(
      table.geoSearch([0, 0], { filter: {}, controls: { $maxDistance: -5 } }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("delegates to the adapter and returns rows carrying $distance", async () => {
    const space = new DbSpace(() => new GeoMockAdapter());
    const table = space.getTable(GeoListing);
    const adapter = space.getAdapter(GeoListing) as GeoMockAdapter;

    const rows = await table.geoSearch([-122.42, 37.77], {
      filter: { status: "ACTIVE" },
      controls: { $maxDistance: 50_000, $limit: 20 },
    });
    expect(rows[0]!.$distance).toBe(42);

    const call = adapter.geoCalls[0]!;
    expect(call.point).toEqual([-122.42, 37.77]);
    expect(call.query.filter).toEqual({ status: "ACTIVE" });
    expect((call.query.controls as Record<string, unknown>).$maxDistance).toBe(50_000);
    expect(call.indexName).toBeUndefined();
  });

  it("targets a named index via the overload", async () => {
    const space = new DbSpace(() => new GeoMockAdapter());
    const table = space.getTable(GeoListing);
    const adapter = space.getAdapter(GeoListing) as GeoMockAdapter;
    await table.geoSearch("second", [1, 2]);
    expect(adapter.geoCalls[0]!.indexName).toBe("second");
  });

  it("geoSearchWithCount returns data + count", async () => {
    const table = new DbSpace(() => new GeoMockAdapter()).getTable(GeoListing);
    const result = await table.geoSearchWithCount([0, 0]);
    expect(result.count).toBe(1);
    expect(result.data[0]!.$distance).toBe(42);
  });
});

describe("$geoWithin — core filter guard", () => {
  const circle = { $geoWithin: { center: [0, 0], radius: 1000 } };

  it("throws GEO_NOT_SUPPORTED on adapters without geo support", async () => {
    const table = new DbSpace(() => new MockAdapter()).getTable(GeoListing);
    await expect(
      table.findMany({ filter: { geo: circle } as FilterExpr, controls: {} }),
    ).rejects.toMatchObject({ code: "GEO_NOT_SUPPORTED" });
  });

  it("throws FILTER_TYPE_MISMATCH on non-geoPoint fields", async () => {
    const table = new DbSpace(() => new GeoMockAdapter()).getTable(GeoListing);
    await expect(
      table.findMany({ filter: { status: circle } as FilterExpr, controls: {} }),
    ).rejects.toMatchObject({ code: "FILTER_TYPE_MISMATCH" });
  });

  it.each([
    ["bad center", { center: [200, 0], radius: 10 }],
    ["zero radius", { center: [0, 0], radius: 0 }],
    ["missing radius", { center: [0, 0] }],
  ])("throws INVALID_QUERY for %s", async (_label, value) => {
    const table = new DbSpace(() => new GeoMockAdapter()).getTable(GeoListing);
    await expect(
      table.findMany({ filter: { geo: { $geoWithin: value } } as FilterExpr, controls: {} }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("passes a valid circle predicate through to the adapter (works unindexed too)", async () => {
    const space = new DbSpace(() => new GeoMockAdapter());
    const table = space.getTable(GeoListing);
    const adapter = space.getAdapter(GeoListing) as GeoMockAdapter;
    await table.findMany({ filter: { geo: circle } as FilterExpr, controls: {} });
    const call = adapter.calls.find((c) => c.method === "findMany")!;
    expect(call.args[0].filter).toEqual({ geo: circle });

    // Composes under $and/$or, and works on an unindexed geoPoint field.
    const unindexed = space.getTable(GeoUnindexed);
    await expect(
      unindexed.findMany({
        filter: { $or: [{ point: circle }, { id: "x" }] } as FilterExpr,
        controls: {},
      }),
    ).resolves.toBeDefined();
  });
});
