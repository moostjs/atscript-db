import { describe, it, expect, vi } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import { createMockApp as makeApp, createMockReadable, errorsOf } from "./test-utils";
import { makeProp } from "./actions-test-utils";

/**
 * Finding 62 (since 0.1.128): a descendant of a `@db.json` / array column is
 * not a column on relational adapters — the request is rejected with 400
 * (envelope `errors[0].path` = the offending path) before any SQL is built.
 * Nested-object adapters keep descriptors for those paths and accept them.
 */

function makeMockTable(adapter: "sql" | "nested") {
  const flatMap = new Map<string, unknown>([
    ["", makeProp("object", {}, "object")],
    ["id", makeProp("string")],
    ["name", makeProp("string")],
    ["address", makeProp("object", { "db.json": true }, "object")],
    ["address.city", makeProp("string")],
    ["address.zip", makeProp("string")],
  ]);
  const base = [
    { path: "id", ignored: false, isIndexed: true, storage: "column", designType: "number" },
    { path: "name", ignored: false, isIndexed: false, storage: "column", designType: "string" },
  ];
  const fieldDescriptors =
    adapter === "sql"
      ? [
          ...base,
          {
            path: "address",
            ignored: false,
            isIndexed: false,
            storage: "json",
            designType: "json",
          },
        ]
      : [
          ...base,
          {
            path: "address",
            ignored: false,
            isIndexed: false,
            storage: "column",
            designType: "json",
          },
          {
            path: "address.city",
            ignored: false,
            isIndexed: false,
            storage: "column",
            designType: "string",
          },
          {
            path: "address.zip",
            ignored: false,
            isIndexed: false,
            storage: "column",
            designType: "string",
          },
        ];
  return createMockReadable({
    tableName: "json_table",
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    },
    flatMap,
    navFields: new Set<string>(),
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
    canFilterField: vi.fn((fd: any) => (adapter === "sql" ? fd.storage !== "json" : true)),
    canSortField: vi.fn((fd: any) => fd.storage !== "json" && fd.designType !== "json"),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    resolveIdFilter: vi.fn((id: unknown) => ({ id })),
    findMany: vi.fn().mockResolvedValue([]),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    findOne: vi.fn().mockResolvedValue({ id: 1 }),
    count: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockResolvedValue([]),
  });
}

/** The structured 400 envelope's `errors` (wooks types `body` loosely). */
describe("JSON descendant paths — relational adapter", () => {
  const REQUESTS = [
    "?$select=id,address.city",
    // A single-entry `$select` parses to the same array shape — the gate must
    // not depend on a sibling column being requested.
    "?$select=address.city",
    "?address.city=x",
    "?$sort=address.city",
    "?$groupBy=address.city&$select=address.city,count()",
    "?$select=id,sum(address.city):s&$groupBy=name",
  ];

  it.each(REQUESTS)(
    "%s → 400 naming the JSON column, nothing reaches the readable",
    async (url) => {
      const table = makeMockTable("sql");
      const result = await new AsDbController(makeApp(), table).query(url);
      expect(result).toBeInstanceOf(HttpError);
      const err = result as HttpError;
      expect(err.body.statusCode).toBe(400);
      expect(err.message).toContain("address");
      expect(err.message).toContain("JSON");
      expect(errorsOf(err)).toEqual([{ path: "address.city", message: err.message }]);
      expect(table.findMany).not.toHaveBeenCalled();
      expect(table.aggregate).not.toHaveBeenCalled();
      expect(table.count).not.toHaveBeenCalled();
    },
  );

  it("/pages, /one/:id and /one (composite) apply the same gate", async () => {
    const table = makeMockTable("sql");
    const ctrl = new AsDbController(makeApp(), table);
    expect(await ctrl.pages("?$sort=address.city")).toBeInstanceOf(HttpError);
    expect(await ctrl.getOne("1", "/one/1?$select=address.city")).toBeInstanceOf(HttpError);
    const composite = await ctrl.getOneComposite({ id: "1" }, "/one?id=1&$select=address.city");
    expect(composite).toBeInstanceOf(HttpError);
    expect(errorsOf(composite)[0].path).toBe("address.city");
    expect(table.findOne).not.toHaveBeenCalled();
    expect(table.findManyWithCount).not.toHaveBeenCalled();
  });

  it("the JSON parent itself is selectable (whole value) — 200", async () => {
    const table = makeMockTable("sql");
    const result = await new AsDbController(makeApp(), table).query("?$select=id,address");
    expect(result).not.toBeInstanceOf(HttpError);
    expect(table.findMany).toHaveBeenCalled();
  });

  // Existence runs before the JSON classification at the HTTP layer (clients pin this
  // wording); the core backstop would say "inside JSON-stored column" for the same path.
  it("an unknown descendant of the JSON column is reported as Unknown field (existence runs before JSON classification)", async () => {
    const table = makeMockTable("sql");
    const result = await new AsDbController(makeApp(), table).query("?address.nope=1");
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toBe('Unknown field "address.nope"');
  });

  it("/meta does not list JSON descendants on relational adapters", async () => {
    const meta = await new AsDbController(makeApp(), makeMockTable("sql")).meta();
    expect(meta.fields["address.city"]).toBeUndefined();
    expect(meta.fields.address).toEqual({ filterable: false, sortable: false });
  });
});

describe("JSON descendant paths — nested-object adapter (native dotted paths)", () => {
  it("filter / $sort / $select on the descendant are accepted and listed in /meta", async () => {
    const table = makeMockTable("nested");
    const ctrl = new AsDbController(makeApp(), table);
    const meta = await ctrl.meta();
    expect(meta.fields["address.city"]).toEqual({ filterable: true, sortable: true });
    expect(meta.fields.address).toEqual({ filterable: true, sortable: false });
    expect(
      await ctrl.query("?address.city=x&$sort=address.city&$select=id,address.city"),
    ).not.toBeInstanceOf(HttpError);
    expect(table.findMany).toHaveBeenCalledTimes(1);
    expect(
      await ctrl.query("?$groupBy=address.city&$select=address.city,count()"),
    ).not.toBeInstanceOf(HttpError);
    expect(table.aggregate).toHaveBeenCalledTimes(1);
  });
});
