import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace, AtscriptDbView, isAtscriptDbView } from "../index";

import { MockAdapter, prepareFixtures } from "./test-utils";

let fixtures: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fixtures = await import("./fixtures/view-hash.as");
});

function space(): DbSpace {
  return new DbSpace(() => new MockAdapter());
}

// ── @db.ignore on views (since 0.1.128) ─────────────────────────────────

describe("AtscriptDbView.getViewColumnMappings", () => {
  it("excludes @db.ignore fields — they have no column anywhere", () => {
    const view = space().getView(fixtures.VhPlain);
    const mappings = view.getViewColumnMappings();
    expect(mappings.map((m) => m.viewColumn)).toEqual(["id", "title"]);
    expect(mappings.some((m) => m.viewColumn === "computed")).toBe(false);
    // The same source of truth tables use
    expect(view.ignoredFields.has("computed")).toBe(true);
  });

  it("still maps ref-backed and aggregate columns", () => {
    const mappings = space().getView(fixtures.VhHavingA).getViewColumnMappings();
    expect(mappings).toEqual([
      {
        viewColumn: "status",
        sourceTable: "vh_tasks",
        sourceColumn: "status",
        aggFn: undefined,
        aggField: undefined,
      },
      {
        viewColumn: "total",
        sourceTable: "vh_tasks",
        sourceColumn: "amount",
        aggFn: "sum",
        aggField: "amount",
      },
    ]);
  });
});

// ── Structural view guard (since 0.1.128) ────────────────────────────────

describe("isAtscriptDbView", () => {
  it("is structural: true for any readable reporting isView, false for tables", () => {
    const s = space();
    const view = s.getView(fixtures.VhPlain);
    const table = s.getTable(fixtures.VhTask);
    expect(isAtscriptDbView(view)).toBe(true);
    expect(isAtscriptDbView(table)).toBe(false);

    // A duck-typed readable from "another copy" of the package
    const duck = { isView: true, tableName: "x" } as any;
    expect(duck instanceof AtscriptDbView).toBe(false);
    expect(isAtscriptDbView(duck)).toBe(true);
  });
});
