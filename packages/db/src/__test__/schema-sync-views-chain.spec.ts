import { describe, it, expect, beforeAll } from "vite-plus/test";
import { defineAnnotatedType as $ } from "@atscript/typescript/utils";

import { BaseDbAdapter, DbSpace } from "../index";
import { SchemaSync, planSchema, type SyncEntry } from "../sync";
import type {
  DbQuery,
  FilterExpr,
  TDbDeleteResult,
  TDbInsertManyResult,
  TDbInsertResult,
  TDbObjectKind,
  TDbUpdateResult,
} from "../types";

import { deleteRowsWhere, prepareFixtures, updateRowsWhere } from "./test-utils";

// Schema sync over views that read views (since 0.1.141): creation order,
// cascade recreation, dependents-first drops, refusals, upstream failures.

let vc: Record<string, any>;

// ── One in-memory "database" shared by every adapter of a space ──────────

let ddl: string[] = [];
let kinds = new Map<string, TDbObjectKind>();
let rows = new Map<string, Array<Record<string, unknown>>>();
/** Managed objects whose `ensureTable` throws. */
let failing = new Set<string>();

class ChainAdapter extends BaseDbAdapter {
  private _rows(): Array<Record<string, unknown>> {
    const name = this._table.tableName;
    if (!rows.has(name)) rows.set(name, []);
    return rows.get(name)!;
  }
  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    this._rows().push(data);
    return { insertedId: data._id ?? data.id ?? this._rows().length };
  }
  async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    for (const row of data) await this.insertOne(row);
    return { insertedCount: data.length, insertedIds: data.map((d) => d._id ?? d.id) };
  }
  async findOne(query: DbQuery): Promise<Record<string, unknown> | null> {
    const filter = (query.filter ?? {}) as Record<string, any>;
    return (
      this._rows().find((row) =>
        Object.entries(filter).every(
          ([k, v]) => row[k] === (v && typeof v === "object" && "$eq" in v ? v.$eq : v),
        ),
      ) ?? null
    );
  }
  async findMany(): Promise<Array<Record<string, unknown>>> {
    return this._rows();
  }
  async count(): Promise<number> {
    return this._rows().length;
  }
  async replaceOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    const pk = this._table.primaryKeys[0] as string;
    const idx = this._rows().findIndex((r) => r[pk] === (filter as any)[pk]);
    if (idx >= 0) this._rows()[idx] = data;
    return { matchedCount: idx >= 0 ? 1 : 0, modifiedCount: idx >= 0 ? 1 : 0 };
  }
  async updateOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    return this.replaceOne(filter, data);
  }
  async deleteOne(filter: FilterExpr): Promise<TDbDeleteResult> {
    const pk = this._table.primaryKeys[0] as string;
    const idx = this._rows().findIndex((r) => r[pk] === (filter as any)[pk]);
    if (idx >= 0) this._rows().splice(idx, 1);
    return { deletedCount: idx >= 0 ? 1 : 0 };
  }
  async updateMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    return updateRowsWhere(this._rows(), filter, data);
  }
  async replaceMany(): Promise<TDbUpdateResult> {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    return deleteRowsWhere(this._rows(), filter);
  }
  async tableExists(): Promise<boolean> {
    return kinds.has(this._table.tableName);
  }
  async ensureTable(): Promise<void> {
    const name = this._table.tableName;
    if (name === "__atscript_control") return;
    if (failing.has(name)) throw new Error(`boom ${name}`);
    ddl.push(`create ${name}`);
    kinds.set(name, this._table.isView ? "view" : "table");
  }
  async syncIndexes(): Promise<void> {}
  async getObjectKind(name: string): Promise<TDbObjectKind | undefined> {
    return kinds.get(name);
  }
  async dropTableByName(name: string): Promise<void> {
    ddl.push(`drop table ${name}`);
    kinds.delete(name);
  }
  async dropViewByName(name: string): Promise<void> {
    ddl.push(`drop view ${name}`);
    kinds.delete(name);
  }
}

function freshSpace(): DbSpace {
  ddl = [];
  kinds = new Map();
  rows = new Map();
  failing = new Set();
  return new DbSpace(() => new ChainAdapter());
}

const at = (prefix: string) => ddl.findIndex((d) => d === prefix);
const byName = (entries: readonly SyncEntry[]) => new Map(entries.map((e) => [e.name, e]));
const viewDdl = () =>
  ddl.filter((d) => !d.startsWith("create vc_employees") && !d.startsWith("create vc_departments"));

/** Rewrites the stored snapshot of `name` so the next run sees its definition as changed. */
function tamperSnapshot(name: string): void {
  const row = rows.get("__atscript_control")!.find((r) => r._id === `table_snapshot:${name}`)!;
  row.value = JSON.stringify({ ...JSON.parse(row.value as string), filterHash: "stale" });
}

beforeAll(async () => {
  await prepareFixtures();
  vc = await import("./fixtures/view-chain.as");
});

const chain = () => [
  vc.VcEmployee,
  vc.VcDepartment,
  vc.VcPeople,
  vc.VcPeopleDepts,
  vc.VcParisPeople,
];

describe("SchemaSync — views over views", () => {
  it("creates views upstream-first whatever the inventory order, and lists view sources in dependsOn", async () => {
    const space = freshSpace();
    const inventory = [
      vc.VcParisPeople,
      vc.VcBigCities,
      vc.VcPeopleDepts,
      vc.VcDeptSizes,
      vc.VcPeople,
      vc.VcCityCounts,
      vc.VcDepartment,
      vc.VcEmployee,
    ];
    const plan = await planSchema(space, inventory);
    const result = await new SchemaSync(space).run(inventory, { force: true });
    expect(result.status).toBe("synced");
    const viewNames = result.entries.filter((e) => e.viewType).map((e) => e.name);
    // Inventory order, each view after the managed views it reads
    expect(viewNames).toEqual([
      "vc_people",
      "vc_people_depts",
      "vc_paris_people",
      "vc_city_counts",
      "vc_big_cities",
      "vc_dept_sizes",
    ]);
    expect(plan.entries.filter((e) => e.viewType).map((e) => e.name)).toEqual(viewNames);
    expect(viewDdl()).toEqual(viewNames.map((n) => `create ${n}`));
    const entry = (name: string) => result.entries.find((e) => e.name === name)!;
    expect(entry("vc_people_depts").dependsOn).toEqual(["vc_departments", "vc_people"]);
    expect(entry("vc_paris_people").dependsOn).toEqual(["vc_people_depts"]);
    expect(entry("vc_dept_sizes").dependsOn).toEqual(["vc_city_counts", "vc_departments"]);
    expect(entry("vc_big_cities").status).toBe("create");
    expect(kinds.get("vc_paris_people")).toBe("view");

    const again = await new SchemaSync(space).run(inventory);
    expect(again.status).toBe("up-to-date");
  });

  it("dedupes aliased joins to their physical table in dependsOn", async () => {
    const space = freshSpace();
    const result = await new SchemaSync(space).run([vc.VcEmployee, vc.VcDepartment, vc.VcStaff], {
      force: true,
    });
    expect(result.status).toBe("synced");
    expect(result.entries.find((e) => e.name === "vc_staff")!.dependsOn).toEqual([
      "vc_departments",
      "vc_employees",
    ]);
  });

  it("recreates dependents when an upstream view is recreated — dependents dropped first, created last", async () => {
    const space = freshSpace();
    const first = await new SchemaSync(space).run(chain(), { force: true });
    expect(first.status).toBe("synced");
    tamperSnapshot("vc_people");

    const plan = await planSchema(space, chain());
    const planned = byName(plan.entries);
    expect(planned.get("vc_people")).toMatchObject({
      status: "alter",
      recreated: true,
      cascadeFrom: [],
    });
    expect(planned.get("vc_people_depts")).toMatchObject({
      status: "alter",
      recreated: true,
      cascadeFrom: ["vc_people"],
    });
    expect(planned.get("vc_paris_people")).toMatchObject({
      status: "alter",
      recreated: true,
      cascadeFrom: ["vc_people_depts"],
    });
    expect(planned.get("vc_people_depts")!.print("plan")).toContain(
      '      · upstream view "vc_people" recreated',
    );

    ddl = [];
    const result = await new SchemaSync(space).run(chain(), { force: true });
    expect(result.status).toBe("synced");
    const ran = byName(result.entries);
    expect(ran.get("vc_paris_people")).toMatchObject({
      status: "alter",
      cascadeFrom: ["vc_people_depts"],
    });
    expect(ran.get("vc_paris_people")!.print("result")).toContain(
      '      · upstream view "vc_people_depts" recreated',
    );
    expect(viewDdl()).toEqual([
      "drop view vc_paris_people",
      "drop view vc_people_depts",
      "drop view vc_people",
      "create vc_people",
      "create vc_people_depts",
      "create vc_paris_people",
    ]);
    // The cascade is settled: the next run has nothing to do
    expect((await new SchemaSync(space).run(chain())).status).toBe("up-to-date");
  });

  it("does not cascade into a view that is being created or that changed on its own", async () => {
    const space = freshSpace();
    await new SchemaSync(space).run(
      [vc.VcEmployee, vc.VcDepartment, vc.VcPeople, vc.VcPeopleDepts],
      {
        force: true,
      },
    );
    tamperSnapshot("vc_people");
    tamperSnapshot("vc_people_depts");
    const result = await new SchemaSync(space).run(chain(), { force: true });
    const entry = (name: string) => result.entries.find((e) => e.name === name)!;
    expect(entry("vc_people_depts")).toMatchObject({
      status: "alter",
      recreated: true,
      cascadeFrom: [],
    });
    expect(entry("vc_paris_people")).toMatchObject({ status: "create", cascadeFrom: [] });
  });

  it("drops removed views dependents-first (from their stored snapshots), before stale managed views", async () => {
    const space = freshSpace();
    await new SchemaSync(space).run([...chain(), vc.VcCityCounts, vc.VcBigCities], { force: true });
    tamperSnapshot("vc_city_counts");
    ddl = [];
    // The people chain and vc_big_cities leave the schema; vc_city_counts is stale
    const result = await new SchemaSync(space).run(
      [vc.VcEmployee, vc.VcDepartment, vc.VcCityCounts],
      {
        force: true,
      },
    );
    expect(result.status).toBe("synced");
    // Removed views first (each before the views it reads), then the stale
    // managed view, then the recreate
    expect(viewDdl()).toEqual([
      "drop view vc_paris_people",
      "drop view vc_people_depts",
      "drop view vc_people",
      "drop view vc_big_cities",
      "drop view vc_city_counts",
      "create vc_city_counts",
    ]);
    expect(at("drop view vc_paris_people")).toBeLessThan(at("drop view vc_people_depts"));
    expect(at("drop view vc_people_depts")).toBeLessThan(at("drop view vc_people"));
    expect(at("drop view vc_big_cities")).toBeLessThan(at("drop view vc_city_counts"));
    expect(result.entries.filter((e) => e.status === "drop").map((e) => e.name)).toEqual([
      "vc_paris_people",
      "vc_people_depts",
      "vc_people",
      "vc_big_cities",
    ]);
  });

  it("refuses to drop a removed view that a managed view still reads (no DDL)", async () => {
    const space = freshSpace();
    await new SchemaSync(space).run(chain(), { force: true });
    ddl = [];
    const result = await new SchemaSync(space).run(
      [vc.VcEmployee, vc.VcDepartment, vc.VcPeopleDepts, vc.VcParisPeople],
      { force: true },
    );
    expect(result.status).toBe("refused");
    const refused = result.entries.find((e) => e.name === "vc_people")!;
    expect(refused.refused).toBe(true);
    expect(refused.errors).toEqual([
      'Cannot drop view "vc_people": it is still referenced by view "vc_people_depts". Add "vc_people" to the sync inventory or remove the reference.',
    ]);
    expect(ddl).toEqual([]);
    expect(kinds.get("vc_people")).toBe("view");
  });

  it("refuses a view whose source is neither in the inventory nor in the database; proceeds once it exists", async () => {
    const space = freshSpace();
    const refused = await new SchemaSync(space).run([vc.VcOverLegacy], { force: true });
    expect(refused.status).toBe("refused");
    expect(refused.entries[0].errors).toEqual([
      'View "vc_over_legacy" reads "vc_legacy" which is neither in the sync inventory nor present in the database',
    ]);
    expect(ddl).toEqual([]);

    kinds.set("vc_legacy", "view");
    const synced = await new SchemaSync(space).run([vc.VcOverLegacy], { force: true });
    expect(synced.status).toBe("synced");
    expect(synced.entries[0]).toMatchObject({ status: "create", dependsOn: [] });
    expect(ddl).toEqual(["create vc_over_legacy"]);
  });

  it("lists an external source view that is in the inventory in dependsOn", async () => {
    const space = freshSpace();
    kinds.set("vc_legacy", "view");
    const sync = new SchemaSync(space);
    const plan = await sync.plan([vc.VcOverLegacy, vc.VcLegacy]);
    const planned = byName(plan.entries);
    expect(planned.get("vc_legacy")).toMatchObject({ viewType: "E", status: "in-sync" });
    expect(planned.get("vc_over_legacy")).toMatchObject({
      status: "create",
      dependsOn: ["vc_legacy"],
    });
    const result = await sync.run([vc.VcOverLegacy, vc.VcLegacy], { force: true });
    expect(result.status).toBe("synced");
    expect(byName(result.entries).get("vc_over_legacy")!.dependsOn).toEqual(["vc_legacy"]);
    expect(ddl).toEqual(["create vc_over_legacy"]);
  });

  it("marks the dependents of a failed upstream view as errors and withholds the hash", async () => {
    const space = freshSpace();
    failing.add("vc_people");
    const result = await new SchemaSync(space).run(chain(), { force: true });
    expect(result.status).toBe("synced");
    const entry = (name: string) => result.entries.find((e) => e.name === name)!;
    expect(entry("vc_people").status).toBe("error");
    expect(entry("vc_people_depts")).toMatchObject({
      status: "error",
      errors: ['Upstream view "vc_people" failed — "vc_people_depts" was not created over it'],
    });
    expect(entry("vc_paris_people")).toMatchObject({
      status: "error",
      errors: [
        'Upstream view "vc_people_depts" failed — "vc_paris_people" was not created over it',
      ],
    });
    expect(viewDdl()).toEqual([]);
    expect(rows.get("__atscript_control")!.some((r) => r._id === "schema_version")).toBe(false);

    // Fixed upstream: the retry creates the whole chain
    failing.clear();
    const retry = await new SchemaSync(space).run(chain());
    expect(retry.status).toBe("synced");
    expect(viewDdl()).toEqual([
      "create vc_people",
      "create vc_people_depts",
      "create vc_paris_people",
    ]);
  });

  it("safe mode keeps removed views tracked; the next executing run drops them dependents-first", async () => {
    const space = freshSpace();
    await new SchemaSync(space).run(chain(), { force: true });
    ddl = [];
    const safe = await new SchemaSync(space).run([vc.VcEmployee, vc.VcDepartment], {
      force: true,
      safe: true,
    });
    expect(safe.status).toBe("synced");
    expect(viewDdl()).toEqual([]);
    expect(kinds.get("vc_paris_people")).toBe("view");
    ddl = [];

    const dropped = await new SchemaSync(space).run([vc.VcEmployee, vc.VcDepartment], {
      force: true,
    });
    expect(dropped.status).toBe("synced");
    expect(viewDdl()).toEqual([
      "drop view vc_paris_people",
      "drop view vc_people_depts",
      "drop view vc_people",
    ]);
  });

  it("refuses managed views that read each other in a cycle", async () => {
    // The compiler rejects this (VW9); the runtime guard covers hand-built or
    // separately compiled models.
    const CycA = { __is_atscript_annotated_type: true, type: {}, metadata: new Map(), id: "CycA" };
    const CycB = { __is_atscript_annotated_type: true, type: {}, metadata: new Map(), id: "CycB" };
    $("object", CycA as any)
      .prop("id", $().designType("number").$type)
      .annotate("db.view", "cyc_a")
      .annotate("db.view.for", () => CycB);
    $("object", CycB as any)
      .prop("id", $().designType("number").$type)
      .annotate("db.view", "cyc_b")
      .annotate("db.view.for", () => CycA);
    const space = freshSpace();
    const result = await new SchemaSync(space).run([CycA as any, CycB as any], { force: true });
    expect(result.status).toBe("refused");
    for (const entry of result.entries) {
      expect(entry.refused).toBe(true);
      expect(entry.errors).toEqual([
        "Managed views form a dependency cycle: cyc_a → cyc_b → cyc_a",
      ]);
    }
    expect(ddl).toEqual([]);
  });
});
