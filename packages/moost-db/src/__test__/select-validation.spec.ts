import { describe, it, expect, vi } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import { createMockApp as makeApp, createMockReadable, errorsOf } from "./test-utils";
import { makeProp } from "./actions-test-utils";

/**
 * `$select` validation through the capability gate (since 0.1.128): root
 * navigation paths are rejected with a `$with` hint, `$with` sub-selects keep
 * working, composite `/one` is gated like `/one/:id`, `@db.writeOnly` fields
 * pass the gate and are stripped by the seal, encrypted descendants name the
 * parent to select instead, nested-object parents expand.
 */

function makeMockTable() {
  const flatMap = new Map<string, unknown>([
    ["", makeProp("object", {}, "object")],
    ["id", makeProp("string")],
    ["title", makeProp("string")],
    ["assigneeId", makeProp("string")],
    ["assignee", makeProp("object", { "db.rel.to": true }, "object")],
    ["assignee.id", makeProp("string")],
    ["assignee.name", makeProp("string")],
    ["contact", makeProp("object", {}, "object")],
    ["contact.email", makeProp("string")],
    ["contact.phone", makeProp("string")],
    ["credentials", makeProp("object", { "db.encrypted": true }, "object")],
    ["credentials.user", makeProp("string")],
    ["apiSecret", makeProp("string", { "db.writeOnly": true })],
  ]);
  const fd = (path: string, extra: Record<string, unknown> = {}) => ({
    path,
    physicalName: path.replace(/\./g, "__"),
    ignored: false,
    isIndexed: false,
    storage: path.includes(".") ? "flattened" : "column",
    designType: "string",
    type: flatMap.get(path),
    ...extra,
  });
  return createMockReadable({
    tableName: "tasks",
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    },
    flatMap,
    navFields: new Set(["assignee"]),
    primaryKeys: ["id"],
    preferredId: ["id"],
    identifications: [{ fields: ["id"], source: "primaryKey" }],
    uniqueProps: new Set<string>(),
    indexes: new Map(),
    relations: new Map([["assignee", { direction: "to", isArray: false, targetType: () => null }]]),
    fieldDescriptors: [
      fd("id", { isIndexed: true }),
      fd("title"),
      fd("assigneeId"),
      fd("contact.email"),
      fd("contact.phone"),
      fd("credentials", { encrypted: true }),
      fd("apiSecret"),
    ],
    isView: false,
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    canFilterField: vi.fn((f: any) => !f.encrypted),
    canSortField: vi.fn((f: any) => !f.encrypted),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    // Mimic the real recursion into the target table for nav paths.
    isValidFieldPath: vi.fn((path: string) => flatMap.has(path) || path === "assignee.email"),
    resolveIdFilter: vi.fn((id: unknown) =>
      id !== null && typeof id === "object" ? { ...(id as object) } : { id },
    ),
    findMany: vi.fn().mockResolvedValue([]),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    findOne: vi.fn().mockResolvedValue({ id: 1 }),
    count: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockResolvedValue([]),
  });
}

/** The structured 400 envelope's `errors` (wooks types `body` loosely). */
describe("$select — navigation paths", () => {
  it("root $select=assignee.name → 400 with the $with hint (envelope path = the nav path)", async () => {
    const table = makeMockTable();
    const result = await new AsDbController(makeApp(), table).query("?$select=id,assignee.name");
    expect(result).toBeInstanceOf(HttpError);
    const err = result as HttpError;
    expect(err.message).toContain("$with=assignee");
    expect(err.message).toContain("navigation path");
    expect(errorsOf(err)).toEqual([{ path: "assignee.name", message: err.message }]);
    expect(table.findMany).not.toHaveBeenCalled();
  });

  it("root filter / $sort on a nav path and a bare nav property are rejected too", async () => {
    const table = makeMockTable();
    const ctrl = new AsDbController(makeApp(), table);
    expect((await ctrl.query("?assignee.name=x")) as HttpError).toBeInstanceOf(HttpError);
    expect((await ctrl.query("?$sort=assignee.name")) as HttpError).toBeInstanceOf(HttpError);
    const bare = await ctrl.query("?$select=assignee");
    expect((bare as HttpError).message).toContain("use $with=assignee");
    expect(table.findMany).not.toHaveBeenCalled();
  });

  it("$with=assignee($select=name) → 200 (sub-selects are validated per relation, not at root)", async () => {
    const table = makeMockTable();
    const result = await new AsDbController(makeApp(), table).query(
      "?$select=title&$with=assignee($select=name)",
    );
    expect(result).not.toBeInstanceOf(HttpError);
    expect(table.isValidFieldPath).toHaveBeenCalledWith("assignee.name");
    expect(table.findMany).toHaveBeenCalled();
  });

  it("$with=assignee($select=bogus) → 400 Unknown field (existence still checked through the target)", async () => {
    const table = makeMockTable();
    const result = await new AsDbController(makeApp(), table).query(
      "?$with=assignee($select=bogus)",
    );
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toBe('Unknown field "assignee.bogus"');
  });
});

describe("$select — composite /one, writeOnly, encrypted descendants, object parents, unknown", () => {
  it("composite /one?…&$select=nope → 400 (the same gate as /one/:id)", async () => {
    const table = makeMockTable();
    const result = await new AsDbController(makeApp(), table).getOneComposite(
      { id: "1" },
      "/one?id=1&$select=nope",
    );
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toBe('Unknown field "nope"');
    expect(errorsOf(result)[0].path).toBe("nope");
    expect(table.findOne).not.toHaveBeenCalled();
  });

  it("composite /one with an unknown $with relation → 400 (validateParsed now runs there)", async () => {
    const table = makeMockTable();
    const result = await new AsDbController(makeApp(), table).getOneComposite(
      { id: "1" },
      "/one?id=1&$with=nope",
    );
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toContain('Unknown relation "nope"');
  });

  it("@db.writeOnly is selectable at the gate and stripped by the seal (200, never projected)", async () => {
    const table = makeMockTable();
    const result = await new AsDbController(makeApp(), table).query("?$select=title,apiSecret");
    expect(result).not.toBeInstanceOf(HttpError);
    const $select = table.findMany.mock.calls[0][0].controls.$select;
    const keys = Array.isArray($select) ? $select : Object.keys($select);
    expect(keys).toContain("title");
    expect(keys).not.toContain("apiSecret");
  });

  it("encrypted descendant → 400 naming the encrypted parent to select instead", async () => {
    const table = makeMockTable();
    const result = await new AsDbController(makeApp(), table).query("?$select=credentials.user");
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toBe(
      '"credentials.user" is inside encrypted field "credentials" — select the encrypted parent "credentials" instead.',
    );
    // The encrypted column itself is selectable.
    expect(
      await new AsDbController(makeApp(), makeMockTable()).query("?$select=credentials"),
    ).not.toBeInstanceOf(HttpError);
  });

  it("nested-object parent: $select expands (200); filter / $sort name the leaves (400)", async () => {
    const table = makeMockTable();
    const ctrl = new AsDbController(makeApp(), table);
    expect(await ctrl.query("?$select=contact")).not.toBeInstanceOf(HttpError);
    const f = await ctrl.query("?contact=x");
    expect((f as HttpError).message).toBe(
      '"contact" is a nested object — filter or sort on one of its leaves (contact.email, contact.phone)',
    );
    const s = await ctrl.query("?$sort=contact");
    expect(errorsOf(s)[0].path).toBe("contact");
    const meta = await ctrl.meta();
    expect(meta.fields.contact).toBeUndefined();
    expect(meta.fields["contact.email"]).toEqual({ filterable: true, sortable: true });
  });

  it("unknown paths in include and exclude form → 400 Unknown field (message unchanged)", async () => {
    const table = makeMockTable();
    const ctrl = new AsDbController(makeApp(), table);
    const inc = await ctrl.query("?$select=title,fakefield");
    expect((inc as HttpError).message).toBe('Unknown field "fakefield"');
    const exc = await ctrl.query("?$select=-fakefield");
    expect((exc as HttpError).message).toBe('Unknown field "fakefield"');
    expect(table.findMany).not.toHaveBeenCalled();
  });
});
