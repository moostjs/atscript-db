import { describe, it, expect, beforeAll } from "vite-plus/test";
import { defineAnnotatedType as $ } from "@atscript/typescript/utils";

import { DbSpace, aliasTargetOf, tableNameOf } from "../index";
import { viewSourceOf } from "../table/view-source";
import { computeTableHash, computeViewSnapshot } from "../sync";

import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

// Views over views and join aliases (since 0.1.141): column mappings read
// an upstream VIEW's own columns (renamed, flattened, JSON, aggregate) and a
// `@db.alias` join is addressed by the alias name over the physical table.
// Existing views — no alias, no view source — hash byte-identically to
// 0.1.140 (pinned below from the 0.1.140 build).

let vc: Record<string, any>;
let vh: Record<string, any>;
let vs: Record<string, any>;
let vg: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  vc = await import("./fixtures/view-chain.as");
  vh = await import("./fixtures/view-hash.as");
  vs = await import("./fixtures/view-source.as");
  vg = await import("./fixtures/view-agg.as");
});

const space = () => new DbSpace(() => new MockAdapter());
const nestedSpace = () => new DbSpace(() => new NestedMockAdapter());

describe("tableNameOf / viewSourceOf / aliasTargetOf", () => {
  it("names a view by its @db.view name and an alias by its type name over the physical table", () => {
    expect(tableNameOf(vc.VcEmployee)).toBe("vc_employees");
    expect(tableNameOf(vc.VcPeople)).toBe("vc_people");
    expect(tableNameOf(vc.VcLegacy)).toBe("vc_legacy");
    expect(viewSourceOf(vc.VcEmployee)).toEqual({
      name: "vc_employees",
      table: "vc_employees",
      type: vc.VcEmployee,
    });
    expect(viewSourceOf(vc.VcPeople)).toEqual({
      name: "vc_people",
      table: "vc_people",
      type: vc.VcPeople,
    });
    expect(viewSourceOf(vc.VcManager)).toEqual({
      name: "VcManager",
      table: "vc_employees",
      type: vc.VcEmployee,
      alias: true,
    });
    expect(aliasTargetOf(vc.VcManager)).toBe(vc.VcEmployee);
    expect(aliasTargetOf(vc.VcEmployee)).toBeUndefined();
  });

  it("VA4: a DbSpace never registers an alias as a table or view", () => {
    const s = space();
    const msg =
      '"VcManager" is a @db.alias of "VcEmployee" — a join scope, not a table or view; register "VcEmployee" instead';
    expect(() => s.get(vc.VcManager)).toThrow(msg);
    expect(() => s.getTable(vc.VcManager)).toThrow(msg);
    expect(() => s.getView(vc.VcManager)).toThrow(msg);
  });

  it("rejects an alias as the entry table at runtime", () => {
    const Bad = { __is_atscript_annotated_type: true, type: {}, metadata: new Map(), id: "Bad" };
    $("object", Bad as any)
      .prop("id", $().designType("number").$type)
      .annotate("db.view", "bad_entry")
      .annotate("db.view.for", () => vc.VcManager);
    expect(() => space().getView(Bad as any).viewPlan).toThrow(
      'View "bad_entry": @db.view.for "VcManager" is a @db.alias — a join alias cannot be the entry table',
    );
  });
});

describe("join aliases — plan, mappings, refs", () => {
  it("keeps the physical target and carries the alias as the scope name", () => {
    const plan = space().getView(vc.VcStaff).viewPlan;
    expect(plan.entryTable).toBe("vc_employees");
    expect(plan.joins.map((j) => [j.targetTable, j.scope, j.kind])).toEqual([
      ["vc_employees", "VcManager", "left"],
      ["vc_employees", "VcMentor", "left"],
      ["vc_departments", "vc_departments", "left"],
      ["vc_departments", "VcParentDept", "left"],
    ]);
  });

  it("maps aliased columns to the alias scope with the target's physical column, nullable on a left join", () => {
    const view = space().getView(vc.VcStaff);
    const by = new Map(view.getViewColumnMappings().map((m) => [m.viewPath, m]));
    expect(by.get("name")).toEqual({
      viewColumn: "name",
      viewPath: "name",
      sourceTable: "vc_employees",
      sourceColumn: "full_name",
    });
    expect(by.get("managerName")).toEqual({
      viewColumn: "managerName",
      viewPath: "managerName",
      sourceTable: "VcManager",
      sourceColumn: "full_name",
      nullable: true,
    });
    expect(by.get("managerCity")).toMatchObject({
      sourceTable: "VcManager",
      sourceColumn: "address__city",
    });
    expect(by.get("mentorName")).toMatchObject({
      sourceTable: "VcMentor",
      sourceColumn: "full_name",
    });
    expect(by.get("deptName")).toMatchObject({
      sourceTable: "vc_departments",
      sourceColumn: "name",
    });
    expect(by.get("parentDeptName")).toMatchObject({
      sourceTable: "VcParentDept",
      sourceColumn: "name",
    });
  });

  it("resolves predicate refs to the alias scope (SQL fragment and document path)", () => {
    const view = space().getView(vc.VcStaff);
    const join = view.viewPlan.joins[0];
    expect(view.resolveFieldRef((join.condition as any).left)).toBe('"VcManager"."id"');
    expect(view.resolveFieldRef((join.condition as any).right)).toBe('"vc_employees"."managerId"');
    expect(view.resolveRefSource({ type: () => vc.VcManager, field: "address.city" })).toEqual({
      table: "VcManager",
      source: { column: "address__city", designType: "string", optional: false },
    });
    const nested = nestedSpace().getView(vc.VcStaff);
    expect(nested.resolveRefSource({ type: () => vc.VcManager, field: "address.city" })).toEqual({
      table: "VcManager",
      source: { column: "address.city", designType: "string", optional: false },
    });
  });
});

describe("views over views — column mappings", () => {
  it("reads an upstream view's OWN physical columns: renamed, flattened, JSON root, JSON leaf", () => {
    const view = space().getView(vc.VcPeopleDepts);
    expect(view.viewPlan.entryTable).toBe("vc_people");
    expect(view.viewPlan.joins[0]).toMatchObject({ targetTable: "vc_departments", kind: "left" });
    expect(view.getViewColumnMappings()).toEqual([
      { viewColumn: "id", viewPath: "id", sourceTable: "vc_people", sourceColumn: "id" },
      {
        viewColumn: "name",
        viewPath: "name",
        sourceTable: "vc_people",
        sourceColumn: "person_name",
      },
      {
        viewColumn: "city",
        viewPath: "city",
        sourceTable: "vc_people",
        sourceColumn: "address__city",
      },
      // A plain (already extracted) leaf column of the upstream view, optional there
      {
        viewColumn: "theme",
        viewPath: "theme",
        sourceTable: "vc_people",
        sourceColumn: "theme",
        nullable: true,
      },
      // A leaf inside the upstream view's JSON column keeps its JSON path
      {
        viewColumn: "level",
        viewPath: "level",
        sourceTable: "vc_people",
        sourceColumn: "settings",
        nullable: true,
        json: { path: ["level"], type: "number" },
      },
      {
        viewColumn: "deptName",
        viewPath: "deptName",
        sourceTable: "vc_departments",
        sourceColumn: "name",
        nullable: true,
      },
    ]);
  });

  it("chains three levels and reads an aggregate column as a plain leaf", () => {
    const paris = space().getView(vc.VcParisPeople);
    expect(paris.viewPlan.entryTable).toBe("vc_people_depts");
    expect(paris.getViewColumnMappings()).toEqual([
      { viewColumn: "id", viewPath: "id", sourceTable: "vc_people_depts", sourceColumn: "id" },
      {
        viewColumn: "name",
        viewPath: "name",
        sourceTable: "vc_people_depts",
        sourceColumn: "name",
      },
      {
        viewColumn: "deptName",
        viewPath: "deptName",
        sourceTable: "vc_people_depts",
        sourceColumn: "deptName",
        nullable: true,
      },
    ]);
    expect(paris.resolveFieldRef((paris.viewPlan.filter as any).left)).toBe(
      '"vc_people_depts"."city"',
    );

    const big = space().getView(vc.VcBigCities);
    expect(big.viewPlan.entryTable).toBe("vc_city_counts");
    expect(big.getViewColumnMappings()).toEqual([
      { viewColumn: "city", viewPath: "city", sourceTable: "vc_city_counts", sourceColumn: "city" },
      {
        viewColumn: "people",
        viewPath: "people",
        sourceTable: "vc_city_counts",
        sourceColumn: "people",
      },
      {
        viewColumn: "maxLevel",
        viewPath: "maxLevel",
        sourceTable: "vc_city_counts",
        sourceColumn: "maxLevel",
        nullable: true,
      },
    ]);
    expect(big.getViewColumnMappings().some((m) => m.aggFn)).toBe(false);
  });

  it("joins a managed view from a table and reads an external view", () => {
    const sizes = space().getView(vc.VcDeptSizes);
    expect(sizes.viewPlan.joins[0]).toMatchObject({ targetTable: "vc_city_counts", kind: "left" });
    expect(sizes.getViewColumnMappings().find((m) => m.viewPath === "people")).toEqual({
      viewColumn: "people",
      viewPath: "people",
      sourceTable: "vc_city_counts",
      sourceColumn: "people",
      nullable: true,
    });
    const legacy = space().getView(vc.VcOverLegacy);
    expect(legacy.viewPlan.entryTable).toBe("vc_legacy");
    expect(legacy.getViewColumnMappings().map((m) => [m.sourceTable, m.sourceColumn])).toEqual([
      ["vc_legacy", "id"],
      ["vc_legacy", "label"],
    ]);
  });

  it("uses document paths for an upstream view on a nested-object adapter", () => {
    const view = nestedSpace().getView(vc.VcPeopleDepts);
    const by = new Map(view.getViewColumnMappings().map((m) => [m.viewPath, m]));
    expect(by.get("city")).toMatchObject({
      sourceTable: "vc_people",
      sourceColumn: "address.city",
    });
    expect(by.get("level")).toEqual({
      viewColumn: "level",
      viewPath: "level",
      sourceTable: "vc_people",
      sourceColumn: "settings.level",
      nullable: true,
    });
  });
});

describe("snapshots", () => {
  it("records an aliased join as { targetTable: alias, table: physical, condition, kind }", () => {
    const snap = computeViewSnapshot(space().getView(vc.VcStaff));
    expect(snap.joinTables![0]).toEqual({
      targetTable: "VcManager",
      table: "vc_employees",
      condition: '{"l":"VcManager.id","op":"$eq","r":{"f":"vc_employees.managerId"}}',
      kind: "left",
    });
    expect(Object.keys(snap.joinTables![0])).toEqual(["targetTable", "table", "condition", "kind"]);
    // A plain join carries no `table` key
    expect(Object.keys(snap.joinTables![2])).toEqual(["targetTable", "condition", "kind"]);
    expect(snap.columns!.find((c) => c.column === "managerName")).toEqual({
      column: "managerName",
      sourceTable: "VcManager",
      sourceColumn: "full_name",
    });
  });

  it("names the upstream view as entryTable and embeds nothing of its definition", () => {
    const snap = computeViewSnapshot(space().getView(vc.VcParisPeople));
    expect(snap.entryTable).toBe("vc_people_depts");
    expect(JSON.stringify(snap)).not.toContain('vc_people"');
    expect(JSON.stringify(snap)).not.toContain("vc_employees");
  });

  // Pinned with the 0.1.140 build (`packages/db/dist`) over the same
  // fixtures: a view without aliases or view sources must hash byte-identically.
  const PINNED_0_1_140: Record<string, Record<string, string>> = {
    "view-hash": {
      VhFilterA: "-795e2155",
      VhFilterB: "-5eea9d18",
      VhHavingA: "3e1806a5",
      VhHavingB: "75271e98",
      VhJoinA: "-655a9f0d",
      VhJoinB: "-7d0c34ab",
      VhPlain: "00ebd655",
    },
    "view-source": { VsChain: "-3eed9520", VsRegionStats: "2c402632", VsUserView: "-40671f3c" },
    "view-agg": { VgStats: "-7059c0af" },
  };
  const PINNED_0_1_140_NESTED: Record<string, string> = {
    VsBadJsonObject: "-417d10bc",
    VsChain: "-3eed9520",
    VsRegionStats: "18053470",
    VsUserView: "-577954ed",
  };

  it("hashes every pre-existing view exactly as 0.1.140 did (relational and nested adapters)", () => {
    const fixtures: Record<string, Record<string, any>> = {
      "view-hash": vh,
      "view-source": vs,
      "view-agg": vg,
    };
    for (const [file, pins] of Object.entries(PINNED_0_1_140)) {
      const hashes: Record<string, string> = {};
      for (const name of Object.keys(pins)) {
        hashes[name] = computeTableHash(computeViewSnapshot(space().getView(fixtures[file][name])));
      }
      expect(hashes, file).toEqual(pins);
    }
    const nested: Record<string, string> = {};
    for (const name of Object.keys(PINNED_0_1_140_NESTED)) {
      nested[name] = computeTableHash(computeViewSnapshot(nestedSpace().getView(vs[name])));
    }
    expect(nested).toEqual(PINNED_0_1_140_NESTED);
  });
});
