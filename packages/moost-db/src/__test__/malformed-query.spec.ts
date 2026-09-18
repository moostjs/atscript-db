import { describe, it, expect, vi } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";

/**
 * A query string the `@uniqu/url` grammar cannot lex (an unquoted `-` in a
 * value, `?name=json-w1`) is the client's fault: since 0.1.128 every read
 * endpoint answers 400 with the validation envelope instead of a 500, at the
 * single place the query string is parsed (`parseUrlOr400`).
 */

function makeEntry(kind: "" | "object") {
  return {
    __is_atscript_annotated_type: true,
    type: { kind, designType: kind === "object" ? undefined : "string", tags: new Set() },
    metadata: new Map(),
  } as any;
}

function makeMockTable() {
  const flatMap = new Map<string, unknown>([
    ["", makeEntry("object")],
    ["id", makeEntry("")],
    ["name", makeEntry("")],
  ]);
  return {
    tableName: "items",
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
    fieldDescriptors: [
      { path: "id", ignored: false, isIndexed: true, storage: "column", designType: "number" },
      { path: "name", ignored: false, isIndexed: false, storage: "column", designType: "string" },
    ],
    isView: false,
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    canFilterField: vi.fn().mockReturnValue(true),
    canSortField: vi.fn().mockReturnValue(true),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    resolveIdFilter: vi.fn((id: unknown) => ({ id })),
    findMany: vi.fn().mockResolvedValue([]),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    findOne: vi.fn().mockResolvedValue({ id: 1 }),
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

async function expect400Envelope(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  const body = (err as HttpError).body as unknown as {
    statusCode: number;
    message: string;
    errors: Array<{ path: string; message: string }>;
  };
  expect(body.statusCode).toBe(400);
  expect(body.message).toMatch(/^Malformed query string: /);
  expect(body.message).toContain("Unexpected char '-'");
  expect(body.errors).toEqual([{ path: "", message: body.message }]);
}

describe("malformed query string → 400 envelope on every read endpoint", () => {
  it("/query, /pages: an unquoted hyphen in a value never reaches the readable", async () => {
    const table = makeMockTable();
    const ctrl = new AsDbController(makeApp(), table);
    await expect400Envelope(ctrl.query("/query?name=json-w1"));
    await expect400Envelope(ctrl.pages("/pages?$size=5&name=json-w1"));
    expect(table.findMany).not.toHaveBeenCalled();
    expect(table.findManyWithCount).not.toHaveBeenCalled();
  });

  it("/one/:id and /one (composite): a control that fails to lex is a 400 too", async () => {
    const table = makeMockTable();
    const ctrl = new AsDbController(makeApp(), table);
    await expect400Envelope(ctrl.getOne("1", "/one/1?$with=owner(name=a-b)"));
    await expect400Envelope(ctrl.getOneComposite({ id: "1" }, "/one?id=1&$with=owner(name=a-b)"));
    expect(table.findOne).not.toHaveBeenCalled();
  });

  it("the quoted form of the same value parses and runs", async () => {
    const table = makeMockTable();
    const ctrl = new AsDbController(makeApp(), table);
    const rows = await ctrl.query("/query?name='json-w1'");
    expect(rows).toEqual([]);
    expect(table.findMany).toHaveBeenCalledTimes(1);
    const query = table.findMany.mock.calls[0][0] as { filter: Record<string, unknown> };
    expect(query.filter).toEqual({ name: "json-w1" });
  });
});
