import { describe, it, expect, vi } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";

/**
 * Regression coverage for BUGS.md BUG-1: `query()`'s aggregate fast path
 * used to short-circuit before `validateParsed` / `checkGates`. Subclass
 * authorization (`validateControls` override) and field-level gates
 * (`checkGates`) were silently bypassed for any request carrying `$groupBy`.
 *
 * The contract these tests pin down:
 *
 *   1. A subclass override of `validateControls` MUST fire on the aggregate
 *      path. Otherwise per-control auth like `controls: { $groupBy: false }`
 *      cannot block aggregate queries.
 *   2. `checkGates` (filter/sort field-level gates from `@db.column.*`)
 *      MUST apply to aggregate queries — a `@db.table.filterable 'manual'`
 *      gate must reject an aggregate filter on an un-annotated field just
 *      like it would a regular query.
 *   3. `validateInsights` keeps blocking unknown insight fields on the
 *      aggregate path (now via `validateParsed`).
 *   4. Happy-path aggregates still dispatch when nothing is denied.
 *
 * Negative-control verified: reverting the fix (moving the aggregate
 * dispatch back above `validateParsed` / `checkGates`) flips every
 * "blocks/applies" assertion below — confirming they hinge on the new
 * ordering and would catch the regression.
 */

function makeMockTable(overrides: Record<string, any> = {}) {
  const mockValidator = {
    validate: vi.fn().mockReturnValue(true),
    errors: [],
  };
  return {
    tableName: "agg_table",
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    },
    flatMap: new Map<string, any>([
      ["", {}],
      ["id", {}],
      ["status", {}],
      ["amount", {}],
      ["region", {}],
    ]),
    primaryKeys: ["id"],
    preferredId: ["id"],
    identifications: [{ fields: ["id"], source: "primaryKey" }],
    uniqueProps: new Set<string>(),
    indexes: new Map(),
    relations: new Map(),
    fieldDescriptors: [
      { path: "id", ignored: false, isIndexed: true, storage: "column" },
      { path: "status", ignored: false, isIndexed: false, storage: "column" },
      { path: "amount", ignored: false, isIndexed: false, storage: "column" },
      { path: "region", ignored: false, isIndexed: false, storage: "column" },
    ],
    isView: false,
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    canFilterField: vi.fn().mockReturnValue(true),
    canSortField: vi.fn().mockReturnValue(true),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    getValidator: vi.fn().mockReturnValue(mockValidator),
    findMany: vi.fn().mockResolvedValue([]),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    aggregate: vi.fn().mockResolvedValue([{ status: "active", total: 100 }]),
    count: vi.fn().mockResolvedValue(0),
    ...overrides,
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

describe("AsDbReadableController.query — aggregate path runs subclass validateControls", () => {
  it("subclass override of validateControls is invoked when $groupBy is present", async () => {
    const validateControls = vi.fn().mockReturnValue(undefined);
    class GatedController extends AsDbController {
      protected override validateControls(
        controls: Record<string, unknown>,
        type: "query" | "pages" | "getOne",
      ): string | undefined {
        return validateControls(controls, type);
      }
    }
    const table = makeMockTable();
    const controller = new GatedController(table, makeMockApp());

    await controller.query("/query?$groupBy=status");

    expect(validateControls).toHaveBeenCalledTimes(1);
    const [controls, type] = validateControls.mock.calls[0];
    expect(type).toBe("query");
    // The full controls object — including $groupBy — must reach the override
    // so per-control authorization can gate on it.
    expect(controls).toEqual(expect.objectContaining({ $groupBy: ["status"] }));
    expect(table.aggregate).toHaveBeenCalled();
  });

  it("subclass override blocking $groupBy returns 400 and never dispatches", async () => {
    class DenyGroupByController extends AsDbController {
      protected override validateControls(
        controls: Record<string, unknown>,
        type: "query" | "pages" | "getOne",
      ): string | undefined {
        if (type === "query" && controls.$groupBy) {
          return "Aggregate queries are not permitted for this role";
        }
        return super.validateControls(controls, type);
      }
    }
    const table = makeMockTable();
    const controller = new DenyGroupByController(table, makeMockApp());

    const result = await controller.query("/query?$groupBy=status");

    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).body.statusCode).toBe(400);
    expect((result as HttpError).body.message).toContain("not permitted");
    expect(table.aggregate).not.toHaveBeenCalled();
  });

  it("checkGates filter gate rejects aggregate filter on un-annotated field", async () => {
    // With `db.table.filterable: manual`, only `@db.column.filterable` fields
    // may be filtered on. The aggregate path must enforce this just like
    // the regular query path.
    const flatMap = new Map<string, any>([
      ["", { metadata: new Map() }],
      ["id", { metadata: new Map() }],
      ["status", { metadata: new Map([["db.column.filterable", true]]) }],
      ["amount", { metadata: new Map() }],
      ["region", { metadata: new Map() }],
    ]);
    const fieldDescriptors = [...flatMap.keys()]
      .filter((p) => p !== "")
      .map((p) => ({ path: p, ignored: false, isIndexed: false, storage: "column" }));
    const table = makeMockTable({
      type: {
        __is_atscript_annotated_type: true,
        type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
        metadata: new Map([["db.table.filterable", "manual"]]),
      },
      flatMap,
      fieldDescriptors,
    });
    const controller = new AsDbController(table, makeMockApp());

    // Filter on `region` (no @db.column.filterable) must be rejected.
    const result = await controller.query("/query?region=west&$groupBy=status");
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).body.statusCode).toBe(400);
    expect((result as HttpError).body.message).toContain('"region"');
    expect(table.aggregate).not.toHaveBeenCalled();
  });

  it("checkGates filter gate accepts aggregate filter on annotated field", async () => {
    const flatMap = new Map<string, any>([
      ["", { metadata: new Map() }],
      ["id", { metadata: new Map() }],
      ["status", { metadata: new Map([["db.column.filterable", true]]) }],
      ["amount", { metadata: new Map() }],
      ["region", { metadata: new Map() }],
    ]);
    const fieldDescriptors = [...flatMap.keys()]
      .filter((p) => p !== "")
      .map((p) => ({ path: p, ignored: false, isIndexed: false, storage: "column" }));
    const table = makeMockTable({
      type: {
        __is_atscript_annotated_type: true,
        type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
        metadata: new Map([["db.table.filterable", "manual"]]),
      },
      flatMap,
      fieldDescriptors,
    });
    const controller = new AsDbController(table, makeMockApp());

    const result = await controller.query("/query?status=active&$groupBy=region");
    expect(result).not.toBeInstanceOf(HttpError);
    expect(table.aggregate).toHaveBeenCalled();
  });

  it("validateInsights still rejects unknown insight fields on aggregate path", async () => {
    const table = makeMockTable();
    const controller = new AsDbController(table, makeMockApp());

    // `sum(unknown_field):total` captures `unknown_field` in insights —
    // `validateInsights` (called from `validateParsed`) must reject because
    // `unknown_field` is not in the flatMap.
    const result = await controller.query(
      "/query?$groupBy=status&$select=status,sum(unknown_field):total",
    );
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).body.statusCode).toBe(400);
    expect(table.aggregate).not.toHaveBeenCalled();
  });

  it("base DTO check does not reject $groupBy as an unknown control", async () => {
    // Without the strip, `validateControls` (DTO) would reject `$groupBy`
    // as an unknown $-property and the aggregate path would never run.
    const table = makeMockTable();
    const controller = new AsDbController(table, makeMockApp());

    const result = await controller.query("/query?$groupBy=status");
    expect(result).not.toBeInstanceOf(HttpError);
    expect(table.aggregate).toHaveBeenCalled();
  });
});
