import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { buildViewPipeline } from "../mongo-view-pipeline";
import { prepareFixtures } from "./test-utils";

// Views over views and join aliases against a real MongoDB (mongodb-memory-
// server 7.0.x), since 0.1.141: `viewOn` a view, `$lookup.from` a view (plain
// and aggregate), aliased joins under `__joined_<Alias>` with the physical
// collection as `from`, a self-join, an external view as source, and the
// cascade recreate when an upstream view changes.

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;
let createdViews: Array<{ name: string; viewOn: string }> = [];

const inventory = () => [
  fx.VcParisPeople,
  fx.VcBigCities,
  fx.VcOverLegacy,
  fx.VcDeptSizes,
  fx.VcPeopleDepts,
  fx.VcStaff,
  fx.VcPeople,
  fx.VcCityCounts,
  fx.VcLegacy,
  fx.VcDepartment,
  fx.VcEmployee,
];

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-chain.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("views_chain");
  const realCreate = db.createCollection.bind(db);
  (db as any).createCollection = async (name: string, opts?: any) => {
    if (opts?.viewOn) createdViews.push({ name, viewOn: opts.viewOn });
    return realCreate(name, opts);
  };
  space = new DbSpace(() => new MongoAdapter(db, client));

  // The external view a managed view reads
  await db.createCollection("vc_legacy", {
    viewOn: "vc_employees",
    pipeline: [{ $project: { _id: 0, id: 1, label: "$full_name" } }],
  });

  const result = await new SchemaSync(space).run(inventory(), { force: true });
  expect(result.entries.filter((e) => e.status === "error")).toEqual([]);
  expect(result.status).toBe("synced");

  await space.getTable(fx.VcDepartment).insertMany([
    { id: 1, name: "Paris" },
    { id: 2, name: "R&D", parentId: 1 },
  ] as never);
  await space.getTable(fx.VcEmployee).insertMany([
    {
      id: 1,
      name: "Ann",
      address: { city: "Paris" },
      settings: { theme: "dark", level: 3 },
      deptId: 1,
    },
    { id: 2, name: "Bob", address: { city: "Lyon" }, managerId: 1, mentorId: 3, deptId: 2 },
    { id: 3, name: "Cid", address: { city: "Paris" }, managerId: 2, settings: { level: 7 } },
    { id: 4, name: "Dan", address: { city: "Nowhere" }, managerId: 1 },
  ] as never);
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

const rows = async (type: any) =>
  (await space.getView(type).findMany({ filter: {}, controls: {} })).toSorted(
    (a: any, b: any) => a.id - b.id,
  );

describe("MongoDB — views over views and join aliases (server)", () => {
  it("creates views upstream-first, viewOn a view, $lookup from a view, aliases under __joined_<Alias>", () => {
    const names = createdViews.map((v) => v.name);
    expect(names.indexOf("vc_people")).toBeLessThan(names.indexOf("vc_people_depts"));
    expect(names.indexOf("vc_people_depts")).toBeLessThan(names.indexOf("vc_paris_people"));
    expect(names.indexOf("vc_city_counts")).toBeLessThan(names.indexOf("vc_dept_sizes"));
    expect(createdViews.find((v) => v.name === "vc_people_depts")!.viewOn).toBe("vc_people");
    expect(createdViews.find((v) => v.name === "vc_paris_people")!.viewOn).toBe("vc_people_depts");
    expect(createdViews.find((v) => v.name === "vc_over_legacy")!.viewOn).toBe("vc_legacy");

    const staff = buildViewPipeline(space.getView(fx.VcStaff));
    expect(staff[0].$lookup).toMatchObject({ from: "vc_employees", as: "__joined_VcManager" });
    expect(staff[1]).toEqual({
      $unwind: { path: "$__joined_VcManager", preserveNullAndEmptyArrays: true },
    });
    expect(staff[2].$lookup).toMatchObject({ from: "vc_employees", as: "__joined_VcMentor" });
    expect(staff[4].$lookup).toMatchObject({
      from: "vc_departments",
      as: "__joined_vc_departments",
    });
    expect(staff[6].$lookup).toMatchObject({
      from: "vc_departments",
      as: "__joined_VcParentDept",
      localField: "__joined_vc_departments.parentId",
      foreignField: "id",
    });
    const project = staff.at(-1)!.$project;
    expect(project.managerName).toEqual({ $ifNull: ["$__joined_VcManager.full_name", null] });
    expect(buildViewPipeline(space.getView(fx.VcDeptSizes))[0].$lookup).toMatchObject({
      from: "vc_city_counts",
    });
  });

  it("self-join through aliases: the manager's and mentor's fields, filter on the alias", async () => {
    expect(await rows(fx.VcStaff)).toEqual([
      {
        id: 1,
        name: "Ann",
        city: "Paris",
        managerName: null,
        managerCity: null,
        mentorName: null,
        deptName: "Paris",
        parentDeptName: null,
      },
      {
        id: 2,
        name: "Bob",
        city: "Lyon",
        managerName: "Ann",
        managerCity: "Paris",
        mentorName: "Cid",
        deptName: "R&D",
        parentDeptName: "Paris",
      },
      {
        id: 4,
        name: "Dan",
        city: "Nowhere",
        managerName: "Ann",
        managerCity: "Paris",
        mentorName: null,
        deptName: null,
        parentDeptName: null,
      },
    ]);
  });

  it("view over view: renamed, nested, JSON root and leaf columns of the upstream view; three levels", async () => {
    expect(await rows(fx.VcPeopleDepts)).toEqual([
      { id: 1, name: "Ann", city: "Paris", theme: "dark", level: 3, deptName: "Paris" },
      { id: 2, name: "Bob", city: "Lyon", theme: null, level: null, deptName: "R&D" },
      { id: 3, name: "Cid", city: "Paris", theme: null, level: 7, deptName: null },
    ]);
    expect(await rows(fx.VcParisPeople)).toEqual([
      { id: 1, name: "Ann", deptName: "Paris" },
      { id: 3, name: "Cid", deptName: null },
    ]);
  });

  it("views over an aggregate view, a table joining an aggregate view, an external view as source", async () => {
    expect(await space.getView(fx.VcBigCities).findMany({ filter: {}, controls: {} })).toEqual([
      { city: "Paris", people: 2, maxLevel: 7 },
    ]);
    expect(await rows(fx.VcDeptSizes)).toEqual([
      { id: 1, name: "Paris", people: 2 },
      { id: 2, name: "R&D", people: null },
    ]);
    expect(await rows(fx.VcOverLegacy)).toEqual([
      { id: 1, label: "Ann" },
      { id: 2, label: "Bob" },
      { id: 3, label: "Cid" },
      { id: 4, label: "Dan" },
    ]);
  });

  it("recreates dependents when an upstream view changes (dependents dropped first); then up-to-date", async () => {
    const control = db.collection("__atscript_control");
    const row = await control.findOne({ _id: "table_snapshot:vc_people" as never });
    await control.updateOne(
      { _id: "table_snapshot:vc_people" as never },
      { $set: { value: JSON.stringify({ ...JSON.parse(row!.value), filterHash: "stale" }) } },
    );
    createdViews = [];
    const result = await new SchemaSync(space).run(inventory(), { force: true });
    expect(result.status).toBe("synced");
    const entry = (name: string) => result.entries.find((e) => e.name === name)!;
    expect(entry("vc_people")).toMatchObject({ status: "alter", recreated: true });
    expect(entry("vc_people_depts")).toMatchObject({ status: "alter", cascadeFrom: ["vc_people"] });
    expect(entry("vc_paris_people")).toMatchObject({
      status: "alter",
      cascadeFrom: ["vc_people_depts"],
    });
    expect(entry("vc_staff").status).toBe("in-sync");
    expect(createdViews.map((v) => v.name)).toEqual([
      "vc_people",
      "vc_people_depts",
      "vc_paris_people",
    ]);
    expect(await rows(fx.VcParisPeople)).toHaveLength(2);
    expect((await new SchemaSync(space).run(inventory())).status).toBe("up-to-date");
  });
});
