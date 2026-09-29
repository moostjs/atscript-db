import { describe, it, expect } from "vite-plus/test";
import {
  computeTableSnapshot,
  computeSchemaHash,
  snapshotToExistingColumns,
  type TTableSnapshot,
} from "../schema/schema-hash";

// Minimal mock readable for testing
function mockReadable(
  overrides: Partial<{
    tableName: string;
    fieldDescriptors: any[];
    indexes: Map<string, any>;
    foreignKeys: Map<string, any>;
  }> = {},
) {
  return {
    tableName: overrides.tableName ?? "test_table",
    fieldDescriptors: overrides.fieldDescriptors ?? [
      {
        path: "id",
        physicalName: "id",
        designType: "number",
        optional: false,
        isPrimaryKey: true,
        ignored: false,
        storage: "column",
      },
      {
        path: "name",
        physicalName: "name",
        designType: "string",
        optional: false,
        isPrimaryKey: false,
        ignored: false,
        storage: "column",
      },
    ],
    indexes: overrides.indexes ?? new Map(),
    foreignKeys: overrides.foreignKeys ?? new Map(),
  } as any;
}

describe("schema-hash", () => {
  describe("computeTableSnapshot", () => {
    it("should extract fields sorted by physicalName", () => {
      const readable = mockReadable({
        fieldDescriptors: [
          {
            path: "name",
            physicalName: "name",
            designType: "string",
            optional: false,
            isPrimaryKey: false,
            ignored: false,
            storage: "column",
          },
          {
            path: "id",
            physicalName: "id",
            designType: "number",
            optional: false,
            isPrimaryKey: true,
            ignored: false,
            storage: "column",
          },
        ],
      });
      const snapshot = computeTableSnapshot(readable);
      expect(snapshot.fields[0].physicalName).toBe("id");
      expect(snapshot.fields[1].physicalName).toBe("name");
    });

    it("should exclude ignored fields", () => {
      const readable = mockReadable({
        fieldDescriptors: [
          {
            path: "id",
            physicalName: "id",
            designType: "number",
            optional: false,
            isPrimaryKey: true,
            ignored: false,
            storage: "column",
          },
          {
            path: "temp",
            physicalName: "temp",
            designType: "string",
            optional: true,
            isPrimaryKey: false,
            ignored: true,
            storage: "column",
          },
        ],
      });
      const snapshot = computeTableSnapshot(readable);
      expect(snapshot.fields.length).toBe(1);
      expect(snapshot.fields[0].physicalName).toBe("id");
    });

    it("should include indexes sorted by key", () => {
      const indexes = new Map([
        [
          "atscript__plain__name",
          { key: "atscript__plain__name", type: "plain", fields: [{ name: "name", sort: "asc" }] },
        ],
        [
          "atscript__unique__email",
          {
            key: "atscript__unique__email",
            type: "unique",
            fields: [{ name: "email", sort: "asc" }],
          },
        ],
      ]);
      const readable = mockReadable({ indexes });
      const snapshot = computeTableSnapshot(readable);
      expect(snapshot.indexes.length).toBe(2);
      expect(snapshot.indexes[0].key).toBe("atscript__plain__name");
      expect(snapshot.indexes[1].key).toBe("atscript__unique__email");
    });
  });

  describe("computeSchemaHash", () => {
    it("should be deterministic", () => {
      const snapshot: TTableSnapshot = {
        tableName: "users",
        fields: [
          {
            physicalName: "id",
            designType: "number",
            optional: false,
            isPrimaryKey: true,
            storage: "column",
          },
        ],
        indexes: [],
        foreignKeys: [],
      };
      const hash1 = computeSchemaHash([snapshot]);
      const hash2 = computeSchemaHash([snapshot]);
      expect(hash1).toBe(hash2);
    });

    it("should change when a field is added", () => {
      const base: TTableSnapshot = {
        tableName: "users",
        fields: [
          {
            physicalName: "id",
            designType: "number",
            optional: false,
            isPrimaryKey: true,
            storage: "column",
          },
        ],
        indexes: [],
        foreignKeys: [],
      };
      const withField: TTableSnapshot = {
        ...base,
        fields: [
          ...base.fields,
          {
            physicalName: "email",
            designType: "string",
            optional: false,
            isPrimaryKey: false,
            storage: "column",
          },
        ],
      };
      expect(computeSchemaHash([base])).not.toBe(computeSchemaHash([withField]));
    });

    it("should change when an index is added", () => {
      const base: TTableSnapshot = {
        tableName: "users",
        fields: [
          {
            physicalName: "id",
            designType: "number",
            optional: false,
            isPrimaryKey: true,
            storage: "column",
          },
        ],
        indexes: [],
        foreignKeys: [],
      };
      const withIndex: TTableSnapshot = {
        ...base,
        indexes: [
          {
            key: "atscript__unique__email",
            type: "unique",
            fields: [{ name: "email", sort: "asc" }],
          },
        ],
      };
      expect(computeSchemaHash([base])).not.toBe(computeSchemaHash([withIndex]));
    });

    it("should be stable regardless of table order", () => {
      const table1: TTableSnapshot = {
        tableName: "a_users",
        fields: [],
        indexes: [],
        foreignKeys: [],
      };
      const table2: TTableSnapshot = {
        tableName: "b_posts",
        fields: [],
        indexes: [],
        foreignKeys: [],
      };
      expect(computeSchemaHash([table1, table2])).toBe(computeSchemaHash([table2, table1]));
    });
  });
});

// ── View snapshot canonicalization (since 0.1.128) ──────────────────────

import { beforeAll } from "vite-plus/test";
import { DbSpace } from "../index";
import type { AtscriptDbView, TViewColumnMapping, TViewPlan } from "../index";
import { MockAdapter, prepareFixtures } from "./test-utils";
import {
  computeViewSnapshot,
  computeTableHash,
  canonicalizeQueryNode,
} from "../schema/schema-hash";

describe("computeViewSnapshot — joins, filter, having", () => {
  let fx: Record<string, any>;

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/view-hash.as");
  });

  function snapshotOf(type: any) {
    return computeViewSnapshot(new DbSpace(() => new MockAdapter()).getView(type));
  }

  it("stores each join with its canonical ON condition", () => {
    const snap = snapshotOf(fx.VhJoinA);
    expect(snap.joinTables).toEqual([
      {
        targetTable: "vh_users",
        condition: JSON.stringify({ l: "vh_users.id", op: "$eq", r: { f: "vh_tasks.assigneeId" } }),
      },
    ]);
  });

  it("changes the hash when only the join condition changes", () => {
    const a = snapshotOf(fx.VhJoinA);
    const b = snapshotOf(fx.VhJoinB);
    expect(a.entryTable).toBe(b.entryTable);
    expect(a.joinTables![0].targetTable).toBe(b.joinTables![0].targetTable);
    expect(a.fields).toEqual(b.fields);
    expect(computeTableHash(a)).not.toBe(computeTableHash(b));
  });

  it("changes the hash when a filter is retargeted to another table (same field name)", () => {
    const a = snapshotOf(fx.VhFilterA);
    const b = snapshotOf(fx.VhFilterB);
    expect(a.filterHash).toBeDefined();
    expect(a.filterHash).not.toBe(b.filterHash);
    expect(computeTableHash(a)).not.toBe(computeTableHash(b));
  });

  it("hashes @db.view.having", () => {
    const a = snapshotOf(fx.VhHavingA);
    const b = snapshotOf(fx.VhHavingB);
    expect(a.havingHash).toBeDefined();
    expect(a.havingHash).not.toBe(b.havingHash);
    expect(computeTableHash(a)).not.toBe(computeTableHash(b));
  });

  it("serializes a join-less view with the documented key order", () => {
    const snap = snapshotOf(fx.VhPlain);
    expect(snap.joinTables).toEqual([]);
    expect(snap.filterHash).toBeUndefined();
    expect(snap.havingHash).toBeUndefined();
    expect(Object.keys(snap)).toEqual([
      "tableName",
      "viewType",
      "entryTable",
      "joinTables",
      "columns",
      "fields",
    ]);
    expect(snap.columns).toEqual([
      { column: "id", sourceTable: "vh_tasks", sourceColumn: "id" },
      { column: "title", sourceTable: "vh_tasks", sourceColumn: "title" },
    ]);
    // Ignored fields are excluded from the snapshot as they are from the DDL
    expect(snap.fields.some((f) => f.physicalName === "computed")).toBe(false);
    expect(snap.columns!.some((c) => c.column === "computed")).toBe(false);
  });

  it("orders keys filterHash, havingHash, materialized before fields", () => {
    expect(Object.keys(snapshotOf(fx.VhHavingA))).toEqual([
      "tableName",
      "viewType",
      "entryTable",
      "joinTables",
      "columns",
      "havingHash",
      "fields",
    ]);
  });

  // 0.1.136 recreates every managed view once: the snapshot now carries the
  // physical column sources, so the stored 0.1.134/0.1.135 hash never matches.
  it("differs from the 0.1.134 snapshot (one-time view recreation)", () => {
    const golden0134 =
      '{"tableName":"vh_plain","viewType":"V","entryTable":"vh_tasks","joinTables":[],"fields":[' +
      '{"physicalName":"id","designType":"number","optional":false,"isPrimaryKey":false,"storage":"column"},' +
      '{"physicalName":"title","designType":"string","optional":false,"isPrimaryKey":false,"storage":"column"}]}';
    const snap = snapshotOf(fx.VhPlain);
    expect(JSON.stringify(snap)).not.toBe(golden0134);
    expect(computeTableHash(snap)).not.toBe("043f96bc");
    // The 0.1.134 part is still there — only the column sources were added
    const { columns: _columns, ...rest } = snap;
    expect(JSON.stringify(rest)).toBe(golden0134);
  });

  it("is byte-identical across two constructions of the same view", () => {
    const a = JSON.stringify(snapshotOf(fx.VhFilterA));
    const b = JSON.stringify(snapshotOf(fx.VhFilterA));
    expect(a).toBe(b);
  });
});

describe("canonicalizeQueryNode", () => {
  // The view's `resolveFieldRef(ref, (n) => n)`: "<table>.<field>", unquoted
  const resolve = (ref: { type?: () => any; field: string }) =>
    `${ref.type ? (ref.type().metadata.get("db.table") as string) : "entry"}.${ref.field}`;
  const users = () => ({ metadata: new Map([["db.table", "users"]]) });

  it("qualifies refs, keeps operators/values, and fixes key order", () => {
    const node = {
      $and: [
        { left: { field: "status" }, op: "$eq", right: "active" },
        { left: { type: users, field: "id" }, op: "$eq", right: { type: users, field: "ownerId" } },
        {
          $or: [
            { left: { field: "n" }, op: "$gt", right: 5 },
            { $not: { left: { field: "deleted" }, op: "$exists" } },
          ],
        },
        { left: { field: "tag" }, op: "$in", right: ["a", "b"] },
        { left: { field: "gone" }, op: "$eq", right: null },
      ],
    } as any;
    expect(canonicalizeQueryNode(node, resolve as any)).toEqual({
      and: [
        { l: "entry.status", op: "$eq", r: "active" },
        { l: "users.id", op: "$eq", r: { f: "users.ownerId" } },
        { or: [{ l: "entry.n", op: "$gt", r: 5 }, { not: { l: "entry.deleted", op: "$exists" } }] },
        { l: "entry.tag", op: "$in", r: ["a", "b"] },
        { l: "entry.gone", op: "$eq", r: null },
      ],
    });
    // No function survives — JSON round-trips losslessly
    const json = JSON.stringify(canonicalizeQueryNode(node, resolve as any));
    expect(json).not.toContain("[fn]");
    expect(JSON.parse(json)).toEqual(canonicalizeQueryNode(node, resolve as any));
  });
});

function realView(type: any) {
  return new DbSpace(() => new MockAdapter()).getView(type);
}

/** The real view with its mappings / plan swapped — everything else unchanged. */
function variant(
  type: any,
  patch: {
    mappings?: (m: TViewColumnMapping[]) => TViewColumnMapping[];
    plan?: (p: TViewPlan) => TViewPlan;
  },
) {
  const real = realView(type);
  return {
    isView: true,
    isExternal: false,
    tableName: real.tableName,
    dbAdapter: real.dbAdapter,
    fieldDescriptors: real.fieldDescriptors,
    viewPlan: patch.plan ? patch.plan(real.viewPlan) : real.viewPlan,
    resolveFieldRef: (ref: any, qi?: any) => real.resolveFieldRef(ref, qi),
    getViewColumnMappings: () =>
      patch.mappings ? patch.mappings(real.getViewColumnMappings()) : real.getViewColumnMappings(),
  } as unknown as AtscriptDbView;
}

const hashOf = (v: AtscriptDbView) => computeTableHash(computeViewSnapshot(v));
const edit = (field: string, change: Partial<TViewColumnMapping>) => (m: TViewColumnMapping[]) =>
  m.map((c) => (c.viewPath === field ? { ...c, ...change } : c));

describe("computeViewSnapshot — column sources and join kind (since 0.1.136)", () => {
  let fx: Record<string, any>;
  let vs: Record<string, any>;

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/view-hash.as");
    vs = await import("./fixtures/view-source.as");
  });

  it("records physical sources (flattened, renamed, JSON leaf)", () => {
    const snap = computeViewSnapshot(realView(vs.VsUserView));
    const byColumn = new Map(snap.columns!.map((c) => [c.column, c]));
    expect(byColumn.get("zip")).toEqual({
      column: "zip",
      sourceTable: "vs_users",
      sourceColumn: "address__zip_code",
    });
    expect(byColumn.get("mode")).toEqual({
      column: "mode",
      sourceTable: "vs_users",
      sourceColumn: "settings",
      jsonPath: '["inner","mode"]',
      jsonType: "string",
    });
    // Sorted by column
    const names = snap.columns!.map((c) => c.column);
    expect(names).toEqual(names.toSorted());
  });

  it("changes the hash when a source column changes", () => {
    const base = hashOf(variant(fx.VhJoinA, {}));
    expect(
      hashOf(variant(fx.VhJoinA, { mappings: edit("title", { sourceColumn: "name" }) })),
    ).not.toBe(base);
  });

  it("changes the hash when the aggregate function or field changes", () => {
    const base = hashOf(variant(fx.VhHavingA, {}));
    expect(hashOf(variant(fx.VhHavingA, { mappings: edit("total", { aggFn: "avg" }) }))).not.toBe(
      base,
    );
    expect(
      hashOf(variant(fx.VhHavingA, { mappings: edit("total", { aggField: "other" }) })),
    ).not.toBe(base);
  });

  it("changes the hash when a JSON path or type changes", () => {
    const base = hashOf(variant(vs.VsUserView, {}));
    expect(
      hashOf(
        variant(vs.VsUserView, {
          mappings: edit("theme", { json: { path: ["x"], type: "string" } }),
        }),
      ),
    ).not.toBe(base);
    expect(
      hashOf(
        variant(vs.VsUserView, {
          mappings: edit("theme", { json: { path: ["theme"], type: "number" } }),
        }),
      ),
    ).not.toBe(base);
  });

  it("changes the hash when an aggregate predicate is added or changed", () => {
    const base = hashOf(variant(fx.VhHavingA, {}));
    const paid = { left: { field: "status" }, op: "$eq", right: "paid" } as any;
    const open = { left: { field: "status" }, op: "$eq", right: "open" } as any;
    const a = hashOf(variant(fx.VhHavingA, { mappings: edit("total", { aggFilter: paid }) }));
    const b = hashOf(variant(fx.VhHavingA, { mappings: edit("total", { aggFilter: open }) }));
    expect(a).not.toBe(base);
    expect(a).not.toBe(b);
    const snap = computeViewSnapshot(
      variant(fx.VhHavingA, { mappings: edit("total", { aggFilter: paid }) }),
    );
    expect(snap.columns!.find((c) => c.column === "total")!.aggFilter).toBe(
      JSON.stringify({ l: "vh_tasks.status", op: "$eq", r: "paid" }),
    );
  });

  it("does not change when view fields are reordered", () => {
    expect(hashOf(variant(fx.VhJoinA, { mappings: (m) => m.toReversed() }))).toBe(
      hashOf(variant(fx.VhJoinA, {})),
    );
  });

  it("emits the join kind only for left joins, and a kind change changes the hash", () => {
    const inner = computeViewSnapshot(variant(fx.VhJoinA, {}));
    expect(inner.joinTables![0]).not.toHaveProperty("kind");
    const leftView = variant(fx.VhJoinA, {
      plan: (p) => ({ ...p, joins: p.joins.map((j) => ({ ...j, kind: "left" as const })) }),
    });
    const left = computeViewSnapshot(leftView);
    expect(left.joinTables![0].kind).toBe("left");
    expect(computeTableHash(left)).not.toBe(computeTableHash(inner));
  });

  it("qualifies predicates with physical columns", () => {
    const snap = computeViewSnapshot(realView(vs.VsChain));
    expect(snap.joinTables).toEqual([
      {
        targetTable: "vs_regions",
        condition: JSON.stringify({ l: "vs_regions.id", op: "$eq", r: { f: "vs_users.regionId" } }),
        kind: "left",
      },
      {
        targetTable: "vs_countries",
        condition: JSON.stringify({
          l: "vs_countries.id",
          op: "$eq",
          r: { f: "vs_regions.countryId" },
        }),
      },
    ]);
    expect(computeViewSnapshot(realView(vs.VsUserView)).filterHash).toBeDefined();
  });
});

/** An adapter declaring a view render revision. */
class RevisedAdapter extends MockAdapter {
  override viewRenderRevision(): string {
    return "7";
  }
}

describe("computeViewSnapshot — adapter render revision (since 0.1.137)", () => {
  let tt: Record<string, any>;

  beforeAll(async () => {
    await prepareFixtures();
    tt = await import("./fixtures/test-table.as");
  });

  it("stores a defined revision on managed views, before `fields`, and changes the hash", () => {
    const plain = computeViewSnapshot(realView(tt.ActiveUsersView));
    expect(plain).not.toHaveProperty("renderRevision");
    const revised = computeViewSnapshot(
      new DbSpace(() => new RevisedAdapter()).getView(tt.ActiveUsersView),
    );
    expect(revised.renderRevision).toBe("7");
    const keys = Object.keys(revised);
    expect(keys.slice(-2)).toEqual(["renderRevision", "fields"]);
    const { renderRevision: _, ...withoutRevision } = revised;
    expect(withoutRevision).toEqual(plain);
    expect(computeTableHash(revised)).not.toBe(computeTableHash(plain));
  });

  it("never stores it on an external view (sync neither creates nor recreates it)", () => {
    const snap = computeViewSnapshot(
      new DbSpace(() => new RevisedAdapter()).getView(tt.LegacyReportView),
    );
    expect(snap.viewType).toBe("E");
    expect(snap).not.toHaveProperty("renderRevision");
  });
});

// ── Derived columns (since 0.1.141) ────────────────────────────────────────

describe("computeTableSnapshot — derived fields", () => {
  it("emits `derived` for derived fields only, after `encrypted`, so other snapshots are byte-identical", () => {
    const plain = mockReadable();
    const before = JSON.stringify(computeTableSnapshot(plain));
    const withDerived = mockReadable({
      fieldDescriptors: [
        ...plain.fieldDescriptors,
        {
          path: "customerId",
          physicalName: "customerId",
          designType: "string",
          optional: true,
          isPrimaryKey: false,
          ignored: false,
          storage: "column",
          derived: {
            sourcePath: "payload.customer.id",
            sourceColumn: "payload",
            jsonPath: ["customer", "id"],
            type: "string",
          },
        },
      ],
    });
    const snapshot = computeTableSnapshot(withDerived);
    const derived = snapshot.fields.find((f) => f.physicalName === "customerId")!;
    expect(Object.keys(derived)).toEqual([
      "physicalName",
      "designType",
      "optional",
      "isPrimaryKey",
      "storage",
      "derived",
    ]);
    expect(derived.derived).toEqual({
      sourceColumn: "payload",
      jsonPath: ["customer", "id"],
      type: "string",
    });
    expect(snapshot.fields.filter((f) => f.physicalName !== "customerId")).toEqual(
      computeTableSnapshot(plain).fields,
    );
    expect(JSON.stringify(computeTableSnapshot(plain))).toBe(before);
  });

  it("snapshotToExistingColumns leaves derived snapshot fields out", () => {
    const snapshot: TTableSnapshot = {
      tableName: "t",
      fields: [
        {
          physicalName: "id",
          designType: "number",
          optional: false,
          isPrimaryKey: true,
          storage: "column",
        },
        {
          physicalName: "payload.customer.id",
          designType: "string",
          optional: true,
          isPrimaryKey: false,
          storage: "column",
          derived: { sourceColumn: "payload", jsonPath: ["customer", "id"], type: "string" },
        },
      ],
      indexes: [],
      foreignKeys: [],
    };
    expect(snapshotToExistingColumns(snapshot).map((c) => c.name)).toEqual(["id"]);
  });
});
