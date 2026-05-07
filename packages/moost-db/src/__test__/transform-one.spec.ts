import { describe, it, expect, vi } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";

// Regression: SECURITY_REPORT.md Finding 1 — `/one/:id` and `/one?...` must
// apply the same row-level read overlay as `/query` / `/pages` so id-based
// reads don't leak existence past `transformFilter`.

interface Row {
  id: string;
  owner: string;
  label: string;
}

const rowAlice: Row = { id: "row-alice", owner: "alice", label: "Alice's row" };
const rowBob: Row = { id: "row-bob", owner: "bob", label: "Bob's row" };

function matchesFilter(row: Record<string, unknown>, filter: unknown): boolean {
  if (!filter || typeof filter !== "object") return true;
  const f = filter as Record<string, unknown>;
  if (Array.isArray(f.$and)) {
    return (f.$and as unknown[]).every((sub) => matchesFilter(row, sub));
  }
  if (Array.isArray(f.$or)) {
    return (f.$or as unknown[]).some((sub) => matchesFilter(row, sub));
  }
  for (const [key, value] of Object.entries(f)) {
    if (key.startsWith("$")) continue;
    if (row[key] !== value) return false;
  }
  return true;
}

function makeTable(rows: Row[]): {
  rows: Row[];
  primaryKeys: string[];
  preferredId: readonly string[];
  identifications: Array<{ fields: readonly string[]; source: string }>;
  fieldDescriptors: Array<{ path: string; ignored: boolean; isIndexed: boolean }>;
  uniqueProps: Set<string>;
  indexes: Map<string, unknown>;
  relations: Map<string, unknown>;
  flatMap: Map<string, unknown>;
  type: { __is_atscript_annotated_type: boolean; type: unknown; metadata: Map<string, unknown> };
  tableName: string;
  isView: false;
  isSearchable: ReturnType<typeof vi.fn>;
  isVectorSearchable: ReturnType<typeof vi.fn>;
  canFilterField: ReturnType<typeof vi.fn>;
  canSortField: ReturnType<typeof vi.fn>;
  getSearchIndexes: ReturnType<typeof vi.fn>;
  getValidator: ReturnType<typeof vi.fn>;
  resolveIdFilter: ReturnType<typeof vi.fn>;
  findOne: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  findManyWithCount: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
} {
  return {
    rows,
    tableName: "_test_rows",
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    },
    flatMap: new Map([
      ["", {}],
      ["id", {}],
      ["owner", {}],
      ["label", {}],
    ]),
    primaryKeys: ["id"],
    preferredId: ["id"],
    identifications: [{ fields: ["id"], source: "primaryKey" }],
    uniqueProps: new Set<string>(),
    indexes: new Map(),
    relations: new Map(),
    fieldDescriptors: [
      { path: "id", ignored: false, isIndexed: true },
      { path: "owner", ignored: false, isIndexed: false },
      { path: "label", ignored: false, isIndexed: false },
    ],
    isView: false,
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    canFilterField: vi.fn().mockReturnValue(true),
    canSortField: vi.fn().mockReturnValue(true),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    getValidator: vi.fn().mockReturnValue({ validate: vi.fn().mockReturnValue(true), errors: [] }),
    resolveIdFilter: vi.fn().mockImplementation((id: unknown) => {
      if (id === null || id === undefined) return null;
      if (typeof id !== "object") return { id };
      const obj = id as Record<string, unknown>;
      if (Object.keys(obj).length === 0) return null;
      return { ...obj };
    }),
    findOne: vi.fn().mockImplementation((q: { filter?: unknown }) => {
      const match = rows.find((r) =>
        matchesFilter(r as unknown as Record<string, unknown>, q.filter),
      );
      return Promise.resolve(match ?? null);
    }),
    findMany: vi.fn().mockImplementation((q: { filter?: unknown }) => {
      const matching = rows.filter((r) =>
        matchesFilter(r as unknown as Record<string, unknown>, q.filter),
      );
      return Promise.resolve(matching);
    }),
    findManyWithCount: vi.fn().mockImplementation((q: { filter?: unknown }) => {
      const matching = rows.filter((r) =>
        matchesFilter(r as unknown as Record<string, unknown>, q.filter),
      );
      return Promise.resolve({ data: matching, count: matching.length });
    }),
    count: vi.fn().mockImplementation((q: { filter?: unknown }) => {
      const matching = rows.filter((r) =>
        matchesFilter(r as unknown as Record<string, unknown>, q.filter),
      );
      return Promise.resolve(matching.length);
    }),
  };
}

function makeApp(): { getLogger: ReturnType<typeof vi.fn> } {
  return {
    getLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      debug: vi.fn(),
    }),
  };
}

describe("AsDbReadableController — row-level read isolation on /one (transformOne)", () => {
  it("/query honours transformFilter (regression baseline)", async () => {
    const table = makeTable([rowAlice, rowBob]);
    class GatedCtrl extends AsDbController {
      protected override transformFilter(filter: any): any {
        return { $and: [filter, { owner: "alice" }] };
      }
    }
    const ctrl = new GatedCtrl(table as never, makeApp() as never);
    const result = (await ctrl.query("/query?")) as Row[];
    expect(result).toEqual([rowAlice]);
  });

  it("GET /one/:id applies alice-scoped transformFilter (bob → 404, alice → row)", async () => {
    const table = makeTable([rowAlice, rowBob]);
    class GatedCtrl extends AsDbController {
      protected override transformFilter(filter: any): any {
        return { $and: [filter, { owner: "alice" }] };
      }
    }
    const ctrl = new GatedCtrl(table as never, makeApp() as never);

    const bob = await ctrl.getOne(rowBob.id, `/one/${rowBob.id}?`);
    expect(bob).toBeInstanceOf(HttpError);
    expect((bob as HttpError).body.statusCode).toBe(404);

    const alice = await ctrl.getOne(rowAlice.id, `/one/${rowAlice.id}?`);
    expect(alice).toEqual(rowAlice);
  });

  it("GET /one composite applies alice-scoped transformFilter (bob → 404, alice → row)", async () => {
    // owner is a unique-index field so the composite path resolves against it.
    const table = makeTable([rowAlice, rowBob]);
    table.indexes = new Map([
      [
        "by_owner",
        {
          key: "by_owner",
          name: "by_owner",
          type: "unique",
          fields: [{ name: "owner", sort: "asc" }],
        },
      ],
    ]);
    table.identifications = [
      { fields: ["id"], source: "primaryKey" },
      { fields: ["owner"], source: "by_owner" },
    ];

    class GatedCtrl extends AsDbController {
      protected override transformFilter(filter: any): any {
        return { $and: [filter, { owner: "alice" }] };
      }
    }
    const ctrl = new GatedCtrl(table as never, makeApp() as never);

    const bob = await ctrl.getOneComposite({ owner: "bob" }, "/one?owner=bob");
    expect(bob).toBeInstanceOf(HttpError);
    expect((bob as HttpError).body.statusCode).toBe(404);

    const alice = await ctrl.getOneComposite({ owner: "alice" }, "/one?owner=alice");
    expect(alice).toEqual(rowAlice);
  });

  it("transformOne overrides transformFilter for /one without affecting /query", async () => {
    const table = makeTable([rowAlice, rowBob]);
    const transformFilterSpy = vi.fn().mockImplementation((f: any) => ({
      $and: [f, { owner: "alice" }],
    }));
    const transformOneSpy = vi.fn().mockImplementation((f: any) => ({
      $and: [f, { owner: "bob" }],
    }));
    class CustomCtrl extends AsDbController {
      protected override transformFilter(filter: any): any {
        return transformFilterSpy(filter);
      }
      protected override transformOne(filter: any): any {
        return transformOneSpy(filter);
      }
    }
    const ctrl = new CustomCtrl(table as never, makeApp() as never);

    // /query uses transformFilter (alice-only).
    const queryResult = (await ctrl.query("/query?")) as Row[];
    expect(queryResult).toEqual([rowAlice]);
    expect(transformFilterSpy).toHaveBeenCalled();

    transformFilterSpy.mockClear();
    transformOneSpy.mockClear();

    // /one uses transformOne (bob-only): alice's id is hidden, bob's resolves.
    const aliceResult = await ctrl.getOne(rowAlice.id, `/one/${rowAlice.id}?`);
    expect(aliceResult).toBeInstanceOf(HttpError);
    expect((aliceResult as HttpError).body.statusCode).toBe(404);
    expect(transformOneSpy).toHaveBeenCalled();
    expect(transformFilterSpy).not.toHaveBeenCalled();

    transformOneSpy.mockClear();
    const bobResult = await ctrl.getOne(rowBob.id, `/one/${rowBob.id}?`);
    expect(bobResult).toEqual(rowBob);
    expect(transformOneSpy).toHaveBeenCalled();
  });

  it("default transformOne (no override) delegates to transformFilter", async () => {
    const table = makeTable([rowAlice, rowBob]);
    const transformFilterSpy = vi.fn().mockImplementation((f: any) => ({
      $and: [f, { owner: "alice" }],
    }));
    class GatedCtrl extends AsDbController {
      protected override transformFilter(filter: any): any {
        return transformFilterSpy(filter);
      }
    }
    const ctrl = new GatedCtrl(table as never, makeApp() as never);

    transformFilterSpy.mockClear();
    await ctrl.getOne(rowAlice.id, `/one/${rowAlice.id}?`);
    expect(transformFilterSpy).toHaveBeenCalled();
  });
});
