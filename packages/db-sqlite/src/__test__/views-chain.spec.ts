import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync, computeTableHash, computeViewSnapshot } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures, RecordingDriver } from "./test-utils";

// Views over views and join aliases on a real SQLite (since 0.1.141): the
// DDL selects FROM a view, joins a view, renders `JOIN "t" AS "Alias"`,
// sync creates upstream-first and recreates dependents with a changed
// upstream; every pre-existing view hashes exactly as before.

let fx: Record<string, any>;
let driver: RecordingDriver;
let space: DbSpace;

const inventory = () => [
  // Deliberately dependents-first: sync must reorder
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
  driver = new RecordingDriver(new BetterSqlite3Driver(":memory:"));
  space = new DbSpace(() => new SqliteAdapter(driver));
  // The external view a managed view reads
  driver.exec(`CREATE TABLE "legacy_src" ("id" INTEGER PRIMARY KEY, "label" TEXT)`);
  driver.exec(`CREATE VIEW "vc_legacy" AS SELECT "id", "label" FROM "legacy_src"`);
  driver.run(`INSERT INTO "legacy_src" VALUES (1, 'one')`);

  const result = await new SchemaSync(space).run(inventory(), { force: true });
  expect(result.entries.filter((e) => e.status === "error")).toEqual([]);
  expect(result.status).toBe("synced");

  await space.getTable(fx.VcDepartment).insertMany([
    { id: 1, name: "Paris" },
    { id: 2, name: "R&D", parentId: 1 },
  ]);
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
  ]);
});

afterAll(() => {
  driver?.close();
});

const viewDdl = () =>
  driver.execs.filter(
    (s) => s.startsWith("CREATE VIEW IF NOT EXISTS") || s.startsWith("DROP VIEW"),
  );
const byId = (a: any, b: any) => a.id - b.id;
const rows = async (type: any) =>
  (await space.getView(type).findMany({ filter: {}, controls: {} })).toSorted(byId);

describe("SQLite — views over views and join aliases", () => {
  it("creates views upstream-first and renders aliases / view sources in the DDL", () => {
    const creates = viewDdl().filter((s) => s.startsWith("CREATE VIEW"));
    const names = creates.map((s) => /^CREATE VIEW IF NOT EXISTS "([^"]+)"/.exec(s)![1]);
    expect(names.indexOf("vc_people")).toBeLessThan(names.indexOf("vc_people_depts"));
    expect(names.indexOf("vc_people_depts")).toBeLessThan(names.indexOf("vc_paris_people"));
    expect(names.indexOf("vc_city_counts")).toBeLessThan(names.indexOf("vc_big_cities"));
    expect(names.indexOf("vc_city_counts")).toBeLessThan(names.indexOf("vc_dept_sizes"));
    const staff = creates.find((s) => s.includes('"vc_staff"'))!;
    expect(staff).toContain(
      'LEFT JOIN "vc_employees" AS "VcManager" ON "VcManager"."id" = "vc_employees"."managerId"',
    );
    expect(staff).toContain('LEFT JOIN "vc_employees" AS "VcMentor"');
    expect(staff).toContain('LEFT JOIN "vc_departments" ON');
    expect(staff).toContain(
      'LEFT JOIN "vc_departments" AS "VcParentDept" ON "VcParentDept"."id" = "vc_departments"."parentId"',
    );
    expect(staff).toContain('"VcManager"."full_name" AS "managerName"');
    expect(creates.find((s) => s.includes('"vc_people_depts"'))).toContain(
      'FROM "vc_people" LEFT JOIN "vc_departments" ON "vc_departments"."id" = "vc_people"."deptId"',
    );
    expect(creates.find((s) => s.includes('"vc_dept_sizes"'))).toContain(
      'LEFT JOIN "vc_city_counts" ON',
    );
    expect(creates.find((s) => s.includes('"vc_over_legacy"'))).toContain('FROM "vc_legacy"');
  });

  it("self-join through aliases: reads the manager's and mentor's columns, filter on the alias", async () => {
    // Filter: manager in Paris, or no manager
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

  it("view over view: renamed, flattened, JSON root and JSON leaf columns of the upstream view", async () => {
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

  it("views over an aggregate view and a table joining a view", async () => {
    const big = space.getView(fx.VcBigCities);
    expect(await big.findMany({ filter: {}, controls: {} })).toEqual([
      { city: "Paris", people: 2, maxLevel: 7 },
    ]);
    const sizes = await rows(fx.VcDeptSizes);
    expect(sizes).toEqual([
      { id: 1, name: "Paris", people: 2 },
      { id: 2, name: "R&D", people: null },
    ]);
    expect(await rows(fx.VcOverLegacy)).toEqual([{ id: 1, label: "one" }]);
  });

  it("recreates dependents (dependents dropped first) when an upstream view changes; a second run is up-to-date", async () => {
    // Make the stored definition of vc_people stale
    driver.run(`UPDATE "__atscript_control" SET "value" = ? WHERE "_id" = ?`, [
      JSON.stringify({
        ...JSON.parse(
          driver.get<any>(
            `SELECT "value" FROM "__atscript_control" WHERE "_id" = 'table_snapshot:vc_people'`,
          )!.value,
        ),
        filterHash: "stale",
      }),
      "table_snapshot:vc_people",
    ]);
    driver.execs.length = 0;
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
    // Every managed view gets its idempotent CREATE IF NOT EXISTS; only the
    // chain is dropped — dependents first — and created again, upstream first
    const chain = viewDdl()
      .map((s) => s.replace(/ AS SELECT.*$/, ""))
      .filter((s) => /"vc_(people|people_depts|paris_people)"/.test(s));
    expect(chain).toEqual([
      'DROP VIEW IF EXISTS "vc_paris_people"',
      'DROP VIEW IF EXISTS "vc_people_depts"',
      'DROP VIEW IF EXISTS "vc_people"',
      'CREATE VIEW IF NOT EXISTS "vc_people"',
      'CREATE VIEW IF NOT EXISTS "vc_people_depts"',
      'CREATE VIEW IF NOT EXISTS "vc_paris_people"',
    ]);
    expect(viewDdl().filter((s) => s.startsWith("DROP VIEW"))).toHaveLength(3);
    expect(await rows(fx.VcParisPeople)).toHaveLength(2);
    expect((await new SchemaSync(space).run(inventory())).status).toBe("up-to-date");
  });

  it("hashes the pre-existing SQLite view fixtures exactly as 0.1.136 / 0.1.140 (no alias, no view source)", async () => {
    const views = {
      ...(await import("./fixtures/views.as")),
      ...(await import("./fixtures/view-json.as")),
    } as Record<string, any>;
    const s = new DbSpace(() => new SqliteAdapter(new BetterSqlite3Driver(":memory:")));
    const hashes: Record<string, string> = {};
    for (const name of [
      "SvCustomerList",
      "SvOrdersLeft",
      "SvOrdersInner",
      "SvOrdersLeftParis",
      "SvCustomerGeo",
      "SvCityTotals",
      "VjItemView",
      "VjTagTotals",
    ]) {
      hashes[name] = computeTableHash(computeViewSnapshot(s.getView(views[name])));
    }
    expect(hashes).toEqual({
      SvCustomerList: "-2ed4d157",
      SvOrdersLeft: "589363e2",
      SvOrdersInner: "-6800fb19",
      SvOrdersLeftParis: "59845f86",
      SvCustomerGeo: "4f7ae51b",
      SvCityTotals: "-4211be85",
      VjItemView: "-306c0100",
      VjTagTotals: "7f08eab4",
    });
  });
});
