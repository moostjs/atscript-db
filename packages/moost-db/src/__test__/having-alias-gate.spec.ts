import { describe, it, expect, vi } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import { createMockApp as makeApp, createMockReadable, errorsOf } from "./test-utils";

/**
 * Aggregate-path gate details (since 0.1.128): `$having` keys are aggregate
 * aliases (`$as`, else `fn_field`) or grouped columns — a real, non-grouped
 * column is a 400 with the core rule's wording (`checkHavingKeys`);
 * `sum(unknown)` keeps its `Unknown field` 400; a filter-node `$`-key uniqu
 * does not know (`$nor`) is a 400, not a 500 (one wording with the core).
 */

function makeMockTable() {
  const flatMap = new Map<string, unknown>([
    ["", { metadata: new Map() }],
    ["id", { metadata: new Map() }],
    ["status", { metadata: new Map() }],
    ["amount", { metadata: new Map() }],
    ["region", { metadata: new Map() }],
  ]);
  const fieldDescriptors = [...flatMap.keys()]
    .filter((p) => p !== "")
    .map((path) => ({
      path,
      ignored: false,
      isIndexed: false,
      storage: "column",
      designType: "string",
    }));
  return createMockReadable({
    tableName: "agg_table",
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
    fieldDescriptors,
    isView: false,
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    canFilterField: vi.fn().mockReturnValue(true),
    canSortField: vi.fn().mockReturnValue(true),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    findMany: vi.fn().mockResolvedValue([]),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    aggregate: vi.fn().mockResolvedValue([{ status: "active", total: 100 }]),
    count: vi.fn().mockResolvedValue(0),
  });
}

/** The structured 400 envelope's `errors` (wooks types `body` loosely). */
describe("aggregate gate — $having aliases", () => {
  it("$having on an explicit alias ($as) passes and reaches the readable intact", async () => {
    const table = makeMockTable();
    const result = await new AsDbController(makeApp(), table).query(
      "/query?$groupBy=status&$select=status,sum(amount):total&$having=total>100",
    );
    expect(result).not.toBeInstanceOf(HttpError);
    expect(table.aggregate).toHaveBeenCalledTimes(1);
    expect(table.aggregate.mock.calls[0][0].controls.$having).toEqual({ total: { $gt: 100 } });
  });

  it("$having on the implicit fn_field alias and on a grouped column passes", async () => {
    const table = makeMockTable();
    const result = await new AsDbController(makeApp(), table).query(
      "/query?$groupBy=status&$select=status,sum(amount)&$having=sum_amount>1&$having=status=active&$sort=-sum_amount",
    );
    expect(result).not.toBeInstanceOf(HttpError);
    expect(table.aggregate).toHaveBeenCalledTimes(1);
  });

  it("$having on a real but non-grouped column → 400 with the core rule's wording, path = the key", async () => {
    const table = makeMockTable();
    const result = await new AsDbController(makeApp(), table).query(
      "/query?$groupBy=status&$select=status,sum(amount):total&$having=region>1",
    );
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toBe(
      '$having key "region" must be an aggregate alias or a $groupBy field',
    );
    expect(errorsOf(result)).toEqual([
      {
        path: "region",
        message: '$having key "region" must be an aggregate alias or a $groupBy field',
      },
    ]);
    expect(table.aggregate).not.toHaveBeenCalled();
  });

  it("$having on an unknown key → 400 Unknown field", async () => {
    const table = makeMockTable();
    const result = await new AsDbController(makeApp(), table).query(
      "/query?$groupBy=status&$select=status,sum(amount):total&$having=nope>1",
    );
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toBe('Unknown field "nope"');
    expect(errorsOf(result)[0].path).toBe("nope");
    expect(table.aggregate).not.toHaveBeenCalled();
  });

  it("sum(unknown_field) → 400 Unknown field (text unchanged)", async () => {
    const table = makeMockTable();
    const result = await new AsDbController(makeApp(), table).query(
      "/query?$groupBy=status&$select=status,sum(unknown_field):total",
    );
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toBe('Unknown field "unknown_field"');
    expect(table.aggregate).not.toHaveBeenCalled();
  });
});

describe("filter gate — unsupported logical operators", () => {
  it("a $nor node (programmatic overlay / raw filter) → 400 instead of reaching the builder", async () => {
    const table = makeMockTable();
    const ctrl = new AsDbController(makeApp(), table);
    vi.spyOn(ctrl as any, "parseQueryString").mockReturnValue({
      filter: { $nor: [{ status: "x" }] },
      controls: {},
      insights: new Map(),
    });
    const result = await ctrl.query("/query?");
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toBe(
      'Unsupported filter operator "$nor" — use $and, $or or $not',
    );
    expect(errorsOf(result)[0].path).toBe("$nor");
    expect(table.findMany).not.toHaveBeenCalled();
  });
});
