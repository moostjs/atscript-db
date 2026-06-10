import { describe, it, expect, vi } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";

// /geo endpoint + /meta flags for @db.index.geo and @db.encrypted
// (geo-index spec §7, field-encryption spec §9).

function makeFieldEntry(annotations: Partial<AtscriptMetadata> = {}, tags: string[] = []) {
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "", designType: "string", tags: new Set(tags) },
    metadata: new Map(Object.entries(annotations)),
  } as any;
}

function makeMockTable({
  geoSearchable = true,
  encryptedFields = [] as string[],
  geoIndexed = [] as string[],
} = {}) {
  const fieldNames = ["id", "status", "geo", "secret"];
  const flatMap = new Map<string, unknown>();
  for (const name of fieldNames) {
    flatMap.set(name, makeFieldEntry({}, name === "geo" ? ["db", "geoPoint"] : []));
  }
  const fieldDescriptors = fieldNames.map((path) => ({
    path,
    physicalName: path,
    ignored: false,
    isIndexed: false,
    storage: "column",
    designType: "string",
    type: flatMap.get(path),
    encrypted: encryptedFields.includes(path) || undefined,
    isGeoPoint: path === "geo" || undefined,
  }));
  const indexes = new Map(
    geoIndexed.map((field) => [
      `atscript__geo__${field}`,
      {
        key: `atscript__geo__${field}`,
        name: field,
        type: "geo",
        fields: [{ name: field, sort: "asc" }],
      },
    ]),
  );
  return {
    tableName: "geo_table",
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    },
    flatMap,
    primaryKeys: ["id"],
    preferredId: ["id"],
    uniqueProps: new Set<string>(),
    indexes,
    relations: new Map(),
    fieldDescriptors,
    isView: false,
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    isGeoSearchable: vi.fn().mockReturnValue(geoSearchable),
    canFilterField: vi.fn((fd: any) => !fd.encrypted),
    canSortField: vi.fn((fd: any) => !fd.encrypted && !fd.isGeoPoint),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    findMany: vi.fn().mockResolvedValue([]),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    geoSearch: vi
      .fn()
      .mockResolvedValue([{ id: "a", status: "ACTIVE", geo: [1, 2], $distance: 42 }]),
    geoSearchWithCount: vi.fn().mockResolvedValue({
      data: [{ id: "a", status: "ACTIVE", geo: [1, 2], $distance: 42 }],
      count: 11,
    }),
  } as any;
}

function makeApp() {
  return {
    getLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      debug: vi.fn(),
    }),
  } as any;
}

describe("GET /meta — encrypted + geo flags", () => {
  it("reports encrypted: true with filterable/sortable vetoed", async () => {
    const table = makeMockTable({ encryptedFields: ["secret"], geoIndexed: ["geo"] });
    const controller = new AsDbController(table, makeApp());
    const meta = await controller.meta();
    expect(meta.fields.secret).toMatchObject({
      encrypted: true,
      filterable: false,
      sortable: false,
    });
    expect(meta.fields.status!.encrypted).toBeUndefined();
  });

  it("reports geo: true on geo-indexed fields and sortable: false", async () => {
    const table = makeMockTable({ geoIndexed: ["geo"] });
    const controller = new AsDbController(table, makeApp());
    const meta = await controller.meta();
    expect(meta.fields.geo).toMatchObject({ geo: true, sortable: false });
    expect(meta.fields.status!.geo).toBeUndefined();
  });

  it("reports geoSearchable + advertises the geo CRUD op when supported", async () => {
    const table = makeMockTable({ geoIndexed: ["geo"] });
    const meta = await new AsDbController(table, makeApp()).meta();
    expect(meta.geoSearchable).toBe(true);
    expect(meta.crud.geo).toContain("center");
  });

  it("geoSearchable is false without a geo index or without adapter support", async () => {
    const noIndex = await new AsDbController(makeMockTable({ geoIndexed: [] }), makeApp()).meta();
    expect(noIndex.geoSearchable).toBe(false);
    expect(noIndex.crud.geo).toBeUndefined();

    const noAdapter = await new AsDbController(
      makeMockTable({ geoSearchable: false, geoIndexed: ["geo"] }),
      makeApp(),
    ).meta();
    expect(noAdapter.geoSearchable).toBe(false);
  });
});

describe("GET /geo — endpoint behavior", () => {
  it("requires $center", async () => {
    const table = makeMockTable({ geoIndexed: ["geo"] });
    const controller = new AsDbController(table, makeApp());
    const result = await controller.geo("/geo?status=ACTIVE");
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toContain("$center");
    expect(table.geoSearch).not.toHaveBeenCalled();
  });

  it("rejects malformed $maxDistance", async () => {
    const table = makeMockTable({ geoIndexed: ["geo"] });
    const controller = new AsDbController(table, makeApp());
    const result = await controller.geo("/geo?$center=1,2&$maxDistance=abc");
    expect(result).toBeInstanceOf(HttpError);
  });

  it("parses $center/$maxDistance and returns distance-carrying rows", async () => {
    const table = makeMockTable({ geoIndexed: ["geo"] });
    const controller = new AsDbController(table, makeApp());
    const rows = (await controller.geo(
      "/geo?$center=-122.42,37.77&$maxDistance=50000&status=ACTIVE",
    )) as any[];
    expect(rows[0].$distance).toBe(42);

    const [point, query] = table.geoSearch.mock.calls[0]!;
    expect(point).toEqual([-122.42, 37.77]);
    expect(query.filter).toEqual({ status: "ACTIVE" });
    expect(query.controls.$maxDistance).toBe(50_000);
    expect(query.controls.$limit).toBe(1000);
  });

  it("targets a named geo index via $index", async () => {
    const table = makeMockTable({ geoIndexed: ["geo"] });
    const controller = new AsDbController(table, makeApp());
    await controller.geo("/geo?$center=1,2&$index=second");
    const call = table.geoSearch.mock.calls[0]!;
    expect(call[0]).toBe("second");
    expect(call[1]).toEqual([1, 2]);
  });

  it("returns the pages envelope when $page/$size are present", async () => {
    const table = makeMockTable({ geoIndexed: ["geo"] });
    const controller = new AsDbController(table, makeApp());
    const result = (await controller.geo("/geo?$center=1,2&$page=2&$size=5")) as any;
    expect(result).toMatchObject({ page: 2, itemsPerPage: 5, count: 11, pages: 3 });
    expect(result.data[0].$distance).toBe(42);

    const [, query] = table.geoSearchWithCount.mock.calls[0]!;
    expect(query.controls.$skip).toBe(5);
    expect(query.controls.$limit).toBe(5);
  });
});
