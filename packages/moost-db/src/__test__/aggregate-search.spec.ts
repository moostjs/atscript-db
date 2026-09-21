import { describe, it, expect, vi } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import { createMockApp } from "./test-utils";

/**
 * `$search` + `$groupBy`. The term narrows the ROWS, `$groupBy` shapes what is
 * left, so a grouped rollup must describe exactly the rows the same search
 * returns in the leaf list. Two implementations exist and exactly one layer may
 * consume the term:
 *
 *  - native text search → the adapter applies it before grouping, so `$search`
 *    and `$index` ride through in the controls untouched;
 *  - `@db.column.searchable` fallback → this controller has already rewritten
 *    the term into the filter, so the controls are dropped before dispatch.
 *
 * Before this, the aggregate path passed the controls through verbatim and no
 * adapter looked at them: a grouped query on a natively-searchable source
 * returned counts for rows the same search excludes. Silently.
 */

function makeFieldEntry(annotations: Record<string, unknown> = {}) {
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "", designType: "string", tags: new Set() },
    metadata: new Map(Object.entries(annotations)),
  } as any;
}

const FIELDS: Record<string, Record<string, unknown>> = {
  id: {},
  status: {},
  amount: {},
  title: { "db.column.searchable": true },
  body: { "db.column.searchable": true },
};

function makeMockTable({
  searchable = false,
  annotated = true,
}: { searchable?: boolean; annotated?: boolean } = {}) {
  const flatMap = new Map<string, any>([["", {}]]);
  for (const [path, annotations] of Object.entries(FIELDS)) {
    flatMap.set(path, makeFieldEntry(annotated ? annotations : {}));
  }
  return {
    tableName: "agg_searched",
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    },
    flatMap,
    primaryKeys: ["id"],
    preferredId: ["id"],
    identifications: [{ fields: ["id"], source: "primaryKey" }],
    uniqueProps: new Set<string>(),
    indexes: new Map(),
    relations: new Map(),
    fieldDescriptors: Object.keys(FIELDS).map((path) => ({
      path,
      ignored: false,
      isIndexed: false,
      storage: "column",
      type: flatMap.get(path),
    })),
    isView: false,
    isSearchable: vi.fn().mockReturnValue(searchable),
    isVectorSearchable: vi.fn().mockReturnValue(true),
    canFilterField: vi.fn().mockReturnValue(true),
    canSortField: vi.fn().mockReturnValue(true),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    getValidator: vi.fn().mockReturnValue({ validate: vi.fn().mockReturnValue(true), errors: [] }),
    findMany: vi.fn().mockResolvedValue([]),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    aggregate: vi.fn().mockResolvedValue([{ status: "active", total: 100 }]),
    count: vi.fn().mockResolvedValue(0),
    search: vi.fn().mockResolvedValue([]),
    searchWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
  } as any;
}

/** The single argument the table's `aggregate()` was called with. */
function aggregateArg(table: any) {
  expect(table.aggregate).toHaveBeenCalledTimes(1);
  return table.aggregate.mock.calls[0][0];
}

describe("aggregate path — native text search", () => {
  it("passes $search through to the adapter and leaves the filter alone", async () => {
    const table = makeMockTable({ searchable: true });
    const controller = new AsDbController(createMockApp(), table);

    const result = await controller.query("/query?$groupBy=status&$search=hotel");

    expect(result).not.toBeInstanceOf(HttpError);
    const { controls, filter } = aggregateArg(table);
    expect(controls.$search).toBe("hotel");
    // Native search wins — no substring fragment is merged into the filter.
    expect(JSON.stringify(filter ?? {})).not.toContain("$regex");
  });

  it("passes a named $index through as well", async () => {
    const table = makeMockTable({ searchable: true });
    const controller = new AsDbController(createMockApp(), table);

    await controller.query("/query?$groupBy=status&$search=hotel&$index=by_title");

    const { controls } = aggregateArg(table);
    expect(controls.$search).toBe("hotel");
    expect(controls.$index).toBe("by_title");
  });

  it("$count rides the same controls, so it counts the searched groups", async () => {
    const table = makeMockTable({ searchable: true });
    const controller = new AsDbController(createMockApp(), table);

    await controller.query("/query?$groupBy=status&$search=hotel&$count=true");

    const { controls } = aggregateArg(table);
    expect(controls.$search).toBe("hotel");
    expect(controls.$count).toBeTruthy();
  });
});

describe("aggregate path — @db.column.searchable fallback", () => {
  it("rewrites the term into the filter and strips the controls", async () => {
    const table = makeMockTable({ searchable: false });
    const controller = new AsDbController(createMockApp(), table);

    await controller.query("/query?$groupBy=status&$search=hotel&$index=by_title");

    const { controls, filter } = aggregateArg(table);
    expect(filter).toEqual({
      $or: [{ title: { $regex: "/hotel/i" } }, { body: { $regex: "/hotel/i" } }],
    });
    // The core rejects `$search` on a source with no native search — the term
    // has already been consumed here, so the controls must not survive.
    expect(controls.$search).toBeUndefined();
    expect(controls.$index).toBeUndefined();
  });

  it("strips the control even when no field carries the annotation", async () => {
    // Nothing to fall back ON: the term is simply dropped (the pre-existing
    // behaviour for un-annotated tables) — but it still must not reach a core
    // that would reject it as unsupported.
    const table = makeMockTable({ searchable: false, annotated: false });
    const controller = new AsDbController(createMockApp(), table);

    await controller.query("/query?$groupBy=status&$search=hotel");

    const { controls, filter } = aggregateArg(table);
    expect(controls.$search).toBeUndefined();
    expect(JSON.stringify(filter ?? {})).not.toContain("$regex");
  });

  it("does not copy the controls when there is nothing to strip", async () => {
    const table = makeMockTable({ searchable: false });
    const controller = new AsDbController(createMockApp(), table);

    await controller.query("/query?$groupBy=status");

    expect(aggregateArg(table).controls.$search).toBeUndefined();
  });
});

describe("aggregate path — combinations that cannot be answered", () => {
  it("rejects $vector + $groupBy instead of matching the term as plain text", async () => {
    const table = makeMockTable({ searchable: true });
    const controller = new AsDbController(createMockApp(), table);

    const result = await controller.query("/query?$groupBy=status&$search=hotel&$vector=embedding");

    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).body.statusCode).toBe(400);
    expect((result as HttpError).body.message).toContain("$vector");
    expect(table.aggregate).not.toHaveBeenCalled();
  });

  it("still rejects $with + $groupBy", async () => {
    const table = makeMockTable({ searchable: true });
    const controller = new AsDbController(createMockApp(), table);

    const result = await controller.query("/query?$groupBy=status&$with=rel");

    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).body.statusCode).toBe(400);
    expect(table.aggregate).not.toHaveBeenCalled();
  });
});
