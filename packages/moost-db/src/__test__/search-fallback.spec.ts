import { describe, it, expect, vi } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";

/**
 * `@db.column.searchable` — the generic `$search` fallback (IMPROVE.md #4):
 * when the adapter reports no native search, the readable controller matches
 * the term as an escaped, case-insensitive substring OR'd across the annotated
 * fields; native search wins when available; no annotation → old behavior
 * (term dropped).
 */

function makeFieldEntry(annotations: Record<string, unknown> = {}) {
  // `__type` (test-only key): "int" = number.int, "number" = a plain float
  const { __type, ...rest } = annotations as Record<string, unknown>;
  const type =
    __type === "int"
      ? { kind: "", designType: "number", tags: new Set(["number", "int"]) }
      : __type === "number"
        ? { kind: "", designType: "number", tags: new Set(["number"]) }
        : { kind: "", designType: "string", tags: new Set() };
  return {
    __is_atscript_annotated_type: true,
    type,
    metadata: new Map(Object.entries(rest)),
  } as any;
}

function makeMockTable({
  fields = {} as Record<string, Record<string, unknown>>,
  searchable = false,
}) {
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
    tableName: "searched_table",
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
    isSearchable: vi.fn().mockReturnValue(searchable),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    isGeoSearchable: vi.fn().mockReturnValue(false),
    calendarBucketUnits: vi.fn().mockReturnValue(new Set()),
    aggregateFns: vi.fn().mockReturnValue(new Set()),
    supportsAggregateExpressions: vi.fn().mockReturnValue(false),
    dimensions: [],
    measures: [],
    canFilterField: vi.fn(() => true),
    canSortField: vi.fn(() => true),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    findMany: vi.fn().mockResolvedValue([]),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    count: vi.fn().mockResolvedValue(0),
    search: vi.fn().mockResolvedValue([]),
    searchWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
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

const SEARCH_FIELDS = {
  id: {},
  jobName: { "db.column.searchable": true },
  description: { "db.column.searchable": true },
  status: {},
};

describe("AsDbReadableController — @db.column.searchable $search fallback", () => {
  it("merges an escaped case-insensitive $or fragment when the adapter has no native search", async () => {
    const table = makeMockTable({ fields: SEARCH_FIELDS });
    const controller = new AsDbController(makeApp(), table);
    const result = await controller.query("?$search=hello");
    expect(result).not.toBeInstanceOf(HttpError);
    const filter = table.findMany.mock.calls[0][0].filter;
    expect(filter).toEqual({
      $or: [{ jobName: { $regex: "/hello/i" } }, { description: { $regex: "/hello/i" } }],
    });
  });

  it("$and-combines the fragment with an existing filter (never spreads)", async () => {
    const table = makeMockTable({ fields: SEARCH_FIELDS });
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?status=ACTIVE&$search=hello");
    const filter = table.findMany.mock.calls[0][0].filter;
    expect(filter.$and).toHaveLength(2);
    expect(filter.$and[0]).toEqual({ status: "ACTIVE" });
    expect(filter.$and[1].$or).toHaveLength(2);
  });

  it("escapes regex metacharacters — the term is always literal", async () => {
    const table = makeMockTable({ fields: SEARCH_FIELDS });
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?$search=a.b*(c)");
    const filter = table.findMany.mock.calls[0][0].filter;
    expect(filter.$or[0].jobName.$regex).toBe(String.raw`/a\.b\*\(c\)/i`);
  });

  it("applies the fallback to $count so grid counts match grid rows", async () => {
    const table = makeMockTable({ fields: SEARCH_FIELDS });
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?$search=hello&$count=true");
    expect(table.count).toHaveBeenCalled();
    const filter = table.count.mock.calls[0][0].filter;
    expect(filter.$or).toHaveLength(2);
  });

  it("applies the fallback on the pages endpoint", async () => {
    const table = makeMockTable({ fields: SEARCH_FIELDS });
    const controller = new AsDbController(makeApp(), table);
    await controller.pages("?$search=hello&$page=1&$size=10");
    const filter = table.findManyWithCount.mock.calls[0][0].filter;
    expect(filter.$or).toHaveLength(2);
  });

  it("native search wins — no fragment is merged when isSearchable()", async () => {
    const table = makeMockTable({ fields: SEARCH_FIELDS, searchable: true });
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?$search=hello");
    expect(table.search).toHaveBeenCalled();
    expect(table.findMany).not.toHaveBeenCalled();
    const filter = table.search.mock.calls[0][1].filter;
    expect(filter?.$or).toBeUndefined();
  });

  it("without searchable annotations the term is dropped (old behavior)", async () => {
    const table = makeMockTable({ fields: { id: {}, name: {} } });
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?$search=hello");
    const filter = table.findMany.mock.calls[0][0].filter;
    expect(filter?.$or).toBeUndefined();
  });

  it("skips fields the adapter vetoes for filtering", async () => {
    const table = makeMockTable({ fields: SEARCH_FIELDS });
    table.canFilterField = vi.fn((fd: { path: string }) => fd.path !== "description");
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?$search=hello");
    const filter = table.findMany.mock.calls[0][0].filter;
    expect(filter.$or).toEqual([{ jobName: { $regex: "/hello/i" } }]);
  });
});

describe("integer @db.column.searchable fields (since 0.1.150)", () => {
  const FIELDS = {
    id: {},
    title: { "db.column.searchable": true },
    refNo: { "db.column.searchable": true, __type: "int" },
    altRefNo: { "db.column.searchable": true, __type: "int" },
    amount: { "db.column.searchable": true, __type: "number" },
  };

  it("an integer field joins the escaped $regex fragment (decimal-text substring)", async () => {
    const table = makeMockTable({ fields: FIELDS });
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?$search=2946");
    const filter = table.findMany.mock.calls[0][0].filter;
    expect(filter.$or).toEqual([
      { title: { $regex: "/2946/i" } },
      { refNo: { $regex: "/2946/i" } },
      { altRefNo: { $regex: "/2946/i" } },
    ]);
  });

  it("a float field is never part of the fragment", async () => {
    const table = makeMockTable({ fields: FIELDS });
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?$search=1");
    const filter = table.findMany.mock.calls[0][0].filter;
    expect(JSON.stringify(filter)).not.toContain("amount");
  });

  it("a hidden integer field never participates", async () => {
    class Hiding extends AsDbController {
      protected override hasField(path: string): boolean {
        return super.hasField(path) && path !== "altRefNo";
      }
    }
    const table = makeMockTable({ fields: FIELDS });
    const controller = new Hiding(makeApp(), table);
    await controller.query("?$search=2946");
    const filter = table.findMany.mock.calls[0][0].filter;
    expect(filter.$or.map((c: Record<string, unknown>) => Object.keys(c)[0])).toEqual([
      "title",
      "refNo",
    ]);
  });
});

describe("$count honours a native $search / $vector term (since 0.1.150)", () => {
  it("counts through searchWithCount when the adapter searches natively", async () => {
    const table = makeMockTable({ fields: SEARCH_FIELDS, searchable: true });
    table.searchWithCount.mockResolvedValue({ data: [], count: 7 });
    const controller = new AsDbController(makeApp(), table);
    const result = await controller.query("?status=ACTIVE&$search=hello&$count=true");
    expect(result).toBe(7);
    expect(table.count).not.toHaveBeenCalled();
    const [term, query, index] = table.searchWithCount.mock.calls[0];
    expect(term).toBe("hello");
    expect(query.filter).toEqual({ status: "ACTIVE" });
    expect(query.controls.$limit).toBe(1);
    expect(index).toBeUndefined();
  });

  it("forwards $index", async () => {
    const table = makeMockTable({ fields: SEARCH_FIELDS, searchable: true });
    table.getSearchIndexes.mockReturnValue([{ name: "ft", type: "text", isDefault: true }]);
    table.searchWithCount.mockResolvedValue({ data: [], count: 2 });
    const controller = new AsDbController(makeApp(), table);
    expect(await controller.query("?$search=hello&$index=ft&$count=true")).toBe(2);
    expect(table.searchWithCount.mock.calls[0][2]).toBe("ft");
  });

  it("still counts plainly without a term, and through the fallback filter", async () => {
    const table = makeMockTable({ fields: SEARCH_FIELDS, searchable: true });
    table.count.mockResolvedValue(3);
    const controller = new AsDbController(makeApp(), table);
    expect(await controller.query("?status=ACTIVE&$count=true")).toBe(3);
    expect(table.searchWithCount).not.toHaveBeenCalled();
  });

  it("counts a $vector search through vectorSearchWithCount", async () => {
    class Embedding extends AsDbController {
      protected override computeEmbedding(): Promise<number[]> {
        return Promise.resolve([1, 2, 3]);
      }
    }
    const table = makeMockTable({ fields: SEARCH_FIELDS });
    table.isVectorSearchable.mockReturnValue(true);
    table.vectorSearchWithCount = vi.fn().mockResolvedValue({ data: [], count: 5 });
    const controller = new Embedding(makeApp(), table);
    const result = await controller.query("?$search=hello&$vector=embedding&$count=true");
    expect(result).toBe(5);
    expect(table.count).not.toHaveBeenCalled();
    const [field, vector, query] = table.vectorSearchWithCount.mock.calls[0];
    expect(field).toBe("embedding");
    expect(vector).toEqual([1, 2, 3]);
    expect(query.controls.$limit).toBe(1000);
  });
});

describe("native index with an integer member follows the index visibility gate (since 0.1.150)", () => {
  const FIELDS = {
    id: {},
    title: { "db.column.searchable": true },
    refNo: { __type: "int" },
  };

  class HidingRefNo extends AsDbController {
    protected override hasField(path: string): boolean {
      return super.hasField(path) && path !== "refNo";
    }
  }

  it("refuses a default index that reads a hidden integer member, as for a hidden string", async () => {
    const table = makeMockTable({ fields: FIELDS, searchable: true });
    table.getSearchIndexes.mockReturnValue([
      { name: "ft", type: "text", isDefault: true, fields: ["title", "refNo"] },
    ]);
    const controller = new HidingRefNo(makeApp(), table);
    const result = await controller.query("?$search=2946");
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).body.statusCode).toBe(400);
    expect(table.search).not.toHaveBeenCalled();
  });

  it("runs the same index when the integer member is visible", async () => {
    const table = makeMockTable({ fields: FIELDS, searchable: true });
    table.getSearchIndexes.mockReturnValue([
      { name: "ft", type: "text", isDefault: true, fields: ["title", "refNo"] },
    ]);
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?$search=2946");
    expect(table.search).toHaveBeenCalled();
  });
});

describe("native $count passes the request's search controls (same builder as /query)", () => {
  it("forwards $fuzzy to the count exactly as /query does", async () => {
    const table = makeMockTable({ fields: SEARCH_FIELDS, searchable: true });
    table.getSearchIndexes.mockReturnValue([{ name: "ft", type: "text", isDefault: true }]);
    table.searchWithCount.mockResolvedValue({ data: [], count: 4 });
    const controller = new AsDbController(makeApp(), table);
    expect(await controller.query("?$search=helo&$fuzzy=1&$count=true")).toBe(4);
    await controller.query("?$search=helo&$fuzzy=1");
    const countControls = table.searchWithCount.mock.calls[0][1].controls;
    const queryControls = table.search.mock.calls[0][1].controls;
    expect(countControls.$fuzzy).toBe(queryControls.$fuzzy);
    expect(String(countControls.$fuzzy)).toBe("1");
    expect(countControls.$limit).toBe(1);
    expect(countControls.$count).toBeUndefined();
  });
});

describe("native index gate treats @db.writeOnly fields as not visible", () => {
  const FIELDS = {
    id: {},
    title: { "db.column.searchable": true },
    pin: { __type: "int", "db.writeOnly": true },
  };

  it("refuses a default index that reads a write-only member", async () => {
    const table = makeMockTable({ fields: FIELDS, searchable: true });
    table.getSearchIndexes.mockReturnValue([
      { name: "ft", type: "text", isDefault: true, fields: ["title", "pin"] },
    ]);
    const controller = new AsDbController(makeApp(), table);
    const result = await controller.query("?$search=4711");
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).body.statusCode).toBe(400);
    expect(table.search).not.toHaveBeenCalled();
  });

  it("runs an index that reads no write-only member", async () => {
    const table = makeMockTable({ fields: FIELDS, searchable: true });
    table.getSearchIndexes.mockReturnValue([
      { name: "ft", type: "text", isDefault: true, fields: ["title"] },
    ]);
    const controller = new AsDbController(makeApp(), table);
    await controller.query("?$search=hello");
    expect(table.search).toHaveBeenCalled();
  });
});
