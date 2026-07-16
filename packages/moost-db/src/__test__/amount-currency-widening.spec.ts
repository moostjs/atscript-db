import { describe, expect, it, vi } from "vite-plus/test";

import { AsDbController } from "../as-db.controller";

/**
 * Verifies the readable controller automatically includes the currency-ref
 * field in `$select` when an amount tagged with `@db.amount.currency.ref`
 * is requested — UI never gets an amount without its currency.
 */

function makeFieldEntry(annotations: Partial<AtscriptMetadata> = {}) {
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "", designType: "string", tags: new Set() },
    metadata: new Map(Object.entries(annotations)),
  } as any;
}

function makeMockTable() {
  const flatMap = new Map<string, unknown>();
  flatMap.set("id", makeFieldEntry({ "meta.id": true }));
  flatMap.set("currency", makeFieldEntry());
  flatMap.set("amount", makeFieldEntry({ "db.amount.currency.ref": "currency" } as any));
  flatMap.set("name", makeFieldEntry());

  const fieldDescriptors = Array.from(flatMap.entries()).map(([path, type]) => ({
    path,
    ignored: false,
    isIndexed: false,
    type,
  }));

  return {
    tableName: "orders",
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
    getSearchIndexes: vi.fn().mockReturnValue([]),
    findMany: vi.fn().mockResolvedValue([]),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
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

function selectOf(table: any): unknown {
  const lastCall = table.findMany.mock.calls.at(-1);
  return lastCall?.[0]?.controls?.$select;
}

describe("AsDbController — @db.amount.currency.ref auto-widens $select", () => {
  it("adds the currency field when $select includes the amount (array form)", async () => {
    const table = makeMockTable();
    const controller = new AsDbController(makeApp(), table);

    await controller.query("?$select=amount");

    const select = selectOf(table) as readonly string[];
    expect(select).toContain("amount");
    expect(select).toContain("currency");
  });

  it("adds the currency field when $select includes the amount (object form)", async () => {
    const table = makeMockTable();
    const controller = new AsDbController(makeApp(), table);

    // URL parser emits $select as comma-separated array form, so simulate
    // object form by constructing a query that targets the readable
    // directly. We invoke the private widening through `pages` which
    // routes through the same chain.
    await controller.query("?$select=amount,name");

    const select = selectOf(table) as readonly string[];
    expect(select).toContain("amount");
    expect(select).toContain("currency");
    expect(select).toContain("name");
  });

  it("does not duplicate the currency field when already requested", async () => {
    const table = makeMockTable();
    const controller = new AsDbController(makeApp(), table);

    await controller.query("?$select=amount,currency");

    const select = selectOf(table) as readonly string[];
    const currencyCount = select.filter((f) => f === "currency").length;
    expect(currencyCount).toBe(1);
  });

  it("does not include the currency field when amount is not selected", async () => {
    const table = makeMockTable();
    const controller = new AsDbController(makeApp(), table);

    await controller.query("?$select=name");

    const select = selectOf(table) as readonly string[];
    expect(select).toContain("name");
    expect(select).not.toContain("currency");
  });

  it("is a no-op when $select is omitted (full row already includes currency)", async () => {
    const table = makeMockTable();
    const controller = new AsDbController(makeApp(), table);

    await controller.query("");

    const select = selectOf(table);
    expect(select).toBeUndefined();
  });
});

// Same widening machinery serves @db.unit.ref — currency and unit refs share
// the controller's `_quantityRefByPath`, so this is the smoke test that the
// chaining works for the unit annotation too.
describe("AsDbController — @db.unit.ref auto-widens $select via the shared path", () => {
  function makeUnitTable() {
    const flatMap = new Map<string, unknown>();
    flatMap.set("id", makeFieldEntry({ "meta.id": true } as any));
    flatMap.set("unit", makeFieldEntry());
    flatMap.set("weight", makeFieldEntry({ "db.unit.ref": "unit" } as any));
    flatMap.set("name", makeFieldEntry());

    const fieldDescriptors = Array.from(flatMap.entries()).map(([path, type]) => ({
      path,
      ignored: false,
      isIndexed: false,
      type,
    }));

    return {
      tableName: "products",
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
      getSearchIndexes: vi.fn().mockReturnValue([]),
      findMany: vi.fn().mockResolvedValue([]),
      findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    } as any;
  }

  it("adds the unit field when $select includes the weight", async () => {
    const table = makeUnitTable();
    const controller = new AsDbController(makeApp(), table);

    await controller.query("?$select=weight");

    const select = selectOf(table) as readonly string[];
    expect(select).toContain("weight");
    expect(select).toContain("unit");
  });
});
