import { describe, it, expect, vi } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";

/**
 * Regression coverage for the rel.to insights validation gap:
 * `validateInsights` used to call `flatMap.has(path)`, which rejects paths
 * like `assignee.name` when the target type (`User`) wasn't expanded by
 * atscript's `flattenAnnotatedType` (because the target lacks
 * `@db.depth.limit`, or was already visited transitively). The fix moves
 * the field-existence check to `readable.isValidFieldPath`, which
 * recurses into the target table when needed.
 *
 * These tests pin the delegation contract: AsDbReadableController.hasField
 * MUST call `readable.isValidFieldPath`, not `flatMap.has`.
 */

function makeMockTable(opts: {
  flatMap: Record<string, unknown>;
  navFields?: Set<string>;
  isValidFieldPath?: (path: string) => boolean;
  relations?: Map<string, unknown>;
}) {
  const flatMap = new Map<string, unknown>([["", {}], ...Object.entries(opts.flatMap)]);
  return {
    tableName: "tasks",
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    },
    flatMap,
    navFields: opts.navFields ?? new Set<string>(),
    primaryKeys: ["id"],
    preferredId: ["id"],
    uniqueProps: new Set<string>(),
    indexes: new Map(),
    relations: opts.relations ?? new Map(),
    fieldDescriptors: [...flatMap.keys()].filter(Boolean).map((path) => ({
      path,
      ignored: false,
      isIndexed: false,
      storage: "column",
    })),
    isView: false,
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    canFilterField: vi.fn().mockReturnValue(true),
    canSortField: vi.fn().mockReturnValue(true),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    isValidFieldPath: vi.fn(opts.isValidFieldPath ?? ((path: string) => flatMap.has(path))),
    findMany: vi.fn().mockResolvedValue([]),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
  } as any;
}

function makeMockApp() {
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

describe("AsDbReadableController.hasField — delegates to readable.isValidFieldPath", () => {
  // Without the delegation fix, this query 400s because `assignee.name` isn't
  // in flatMap. With it, isValidFieldPath returns true (the user's mock here
  // simulates the recursion into User's flatMap) and the query dispatches.
  it("accepts $with=<rel.to>($select=<field>) when isValidFieldPath returns true even though flatMap doesn't have the nested path", async () => {
    const table = makeMockTable({
      flatMap: { id: {}, title: {}, assigneeId: {}, assignee: {} },
      navFields: new Set(["assignee"]),
      // Mimic the recursion fallback — assignee.name resolves via the target table.
      isValidFieldPath: (path: string) => {
        if (path === "assignee.name" || path === "assignee.id") return true;
        return ["id", "title", "assigneeId", "assignee"].includes(path);
      },
      relations: new Map([
        ["assignee", { direction: "to", isArray: false, targetType: () => null } as any],
      ]),
    });
    const controller = new AsDbController(makeMockApp(), table);
    const result = await controller.query("?$with=assignee($select=name)");
    expect(result).not.toBeInstanceOf(HttpError);
    expect(table.isValidFieldPath).toHaveBeenCalledWith("assignee.name");
    expect(table.findMany).toHaveBeenCalled();
  });

  it("rejects $with=<rel.to>($select=<unknownField>) when isValidFieldPath returns false", async () => {
    const table = makeMockTable({
      flatMap: { id: {}, title: {}, assigneeId: {}, assignee: {} },
      navFields: new Set(["assignee"]),
      isValidFieldPath: (path: string) => {
        // Simulates: `assignee.name` exists on target, but `assignee.bogus` doesn't.
        if (path === "assignee.name") return true;
        return ["id", "title", "assigneeId", "assignee"].includes(path);
      },
      relations: new Map([
        ["assignee", { direction: "to", isArray: false, targetType: () => null } as any],
      ]),
    });
    const controller = new AsDbController(makeMockApp(), table);
    const result = await controller.query("?$with=assignee($select=bogus)");
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toMatch(/assignee\.bogus/);
    expect(table.findMany).not.toHaveBeenCalled();
  });

  it("still accepts top-level fields directly via the fast path", async () => {
    const table = makeMockTable({
      flatMap: { id: {}, title: {} },
    });
    const controller = new AsDbController(makeMockApp(), table);
    const result = await controller.query("?$select=id,title");
    expect(result).not.toBeInstanceOf(HttpError);
    expect(table.isValidFieldPath).toHaveBeenCalled();
  });
});
