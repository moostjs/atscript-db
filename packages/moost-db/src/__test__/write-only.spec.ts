import { describe, it, expect, vi } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";

/**
 * `@db.writeOnly` (IMPROVE.md #2): fields settable through write payloads but
 * sealed out of every read surface — projections always exclude them, and
 * filter/sort/aggregate references are rejected (an equality probe or sort
 * order would leak the sealed value).
 */

function makeFieldEntry(annotations: Partial<AtscriptMetadata> = {}) {
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "", designType: "string", tags: new Set() },
    metadata: new Map(Object.entries(annotations)),
  } as any;
}

function makeMockTable(fields: Record<string, Partial<AtscriptMetadata>>) {
  const flatMap = new Map<string, unknown>();
  for (const [path, annotations] of Object.entries(fields)) {
    flatMap.set(path, makeFieldEntry(annotations));
  }
  const fieldDescriptors = Array.from(flatMap.entries()).map(([path, type]) => ({
    path,
    ignored: false,
    isIndexed: false,
    storage: "column",
    type,
  }));
  return {
    tableName: "sealed_table",
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    },
    flatMap,
    primaryKeys: ["id"],
    preferredId: ["id"],
    uniqueProps: new Set<string>(),
    indexes: new Map(),
    relations: new Map(),
    fieldDescriptors,
    isView: false,
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    canFilterField: vi.fn(() => true),
    canSortField: vi.fn(() => true),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    findMany: vi.fn().mockResolvedValue([]),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    count: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockResolvedValue([]),
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

const FIELDS = {
  id: {},
  name: {},
  apiSecret: { "db.writeOnly": true },
};

describe("AsDbReadableController — @db.writeOnly read sealing", () => {
  it("excludes the sealed field when no $select is requested", async () => {
    const table = makeMockTable(FIELDS);
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?");
    const $select = table.findMany.mock.calls[0][0].controls.$select;
    // Exclusion is inverted to an explicit inclusion of the surviving fields.
    expect($select).toBeDefined();
    expect($select.apiSecret).toBeUndefined();
    expect($select.name).toBe(1);
    expect($select.id).toBe(1);
  });

  it("strips the sealed field from an explicit inclusion $select", async () => {
    const table = makeMockTable(FIELDS);
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?$select=name,apiSecret");
    const $select = table.findMany.mock.calls[0][0].controls.$select;
    const asArray = Array.isArray($select) ? $select : Object.keys($select);
    expect(asArray).toContain("name");
    expect(asArray).not.toContain("apiSecret");
  });

  it("seals even when the ONLY selected field is write-only", async () => {
    const table = makeMockTable(FIELDS);
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?$select=apiSecret");
    const $select = table.findMany.mock.calls[0][0].controls.$select;
    expect($select).toBeDefined();
    const keys = Array.isArray($select) ? $select : Object.keys($select);
    expect(keys).not.toContain("apiSecret");
    expect(keys.length).toBeGreaterThan(0);
  });

  it("rejects filters on the sealed field (equality probing leaks)", async () => {
    const table = makeMockTable(FIELDS);
    const controller = new AsDbController(makeApp(), table);
    const result = await controller.query("?apiSecret=hunter2");
    expect(result).toBeInstanceOf(HttpError);
    expect(table.findMany).not.toHaveBeenCalled();
  });

  it("rejects aggregate $groupBy on the sealed field", async () => {
    const table = makeMockTable(FIELDS);
    const controller = new AsDbController(makeApp(), table);
    const result = await controller.query("?$groupBy=apiSecret");
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toContain("writeOnly");
    expect(table.aggregate).not.toHaveBeenCalled();
  });

  it("excludes write-only fields from the $search fallback", async () => {
    const table = makeMockTable({
      id: {},
      name: { "db.column.searchable": true },
      apiSecret: { "db.writeOnly": true, "db.column.searchable": true },
    });
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?$search=abc");
    const filter = table.findMany.mock.calls[0][0].filter;
    expect(filter.$or).toEqual([{ name: { $regex: "/abc/i" } }]);
  });

  it("normal fields keep working untouched alongside a sealed one", async () => {
    const table = makeMockTable(FIELDS);
    const controller = new AsDbController(makeApp(), table);
    const result = await controller.query("?name=Ada");
    expect(result).not.toBeInstanceOf(HttpError);
    expect(table.findMany).toHaveBeenCalled();
    expect(table.findMany.mock.calls[0][0].filter).toEqual({ name: "Ada" });
  });
});
