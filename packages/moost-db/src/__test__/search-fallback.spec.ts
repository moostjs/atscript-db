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

function makeFieldEntry(annotations: Partial<AtscriptMetadata> = {}) {
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "", designType: "string", tags: new Set() },
    metadata: new Map(Object.entries(annotations)),
  } as any;
}

function makeMockTable({
  fields = {} as Record<string, Partial<AtscriptMetadata>>,
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
