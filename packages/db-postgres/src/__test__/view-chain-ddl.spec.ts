import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

// Views over views and join aliases (since 0.1.141): the CREATE VIEW DDL the
// adapter issues — FROM a view, JOIN a view, `JOIN "t" AS "Alias"`.
// (The statements are executed against PostgreSQL in the PGlite check that
// accompanies this change; sync ordering is covered by the core.)

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-chain.as");
});

async function createViewSql(type: any): Promise<string> {
  const driver = createMockDriver();
  const space = new DbSpace(() => new PostgresAdapter(driver));
  await space.getView(type).dbAdapter.ensureTable();
  const ddl = driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);
  expect(ddl).toHaveLength(1);
  return ddl[0];
}

describe("PostgresAdapter — views over views and join aliases", () => {
  it("renders aliased joins as JOIN ... AS and addresses them by the alias", async () => {
    const sql = await createViewSql(fx.VcStaff);
    expect(sql).toBe(
      'CREATE OR REPLACE VIEW "vc_staff" AS SELECT "vc_employees"."id" AS "id", "vc_employees"."full_name" AS "name", "vc_employees"."address__city" AS "city", ' +
        '"VcManager"."full_name" AS "managerName", "VcManager"."address__city" AS "managerCity", "VcMentor"."full_name" AS "mentorName", ' +
        '"vc_departments"."name" AS "deptName", "VcParentDept"."name" AS "parentDeptName" FROM "vc_employees" ' +
        'LEFT JOIN "vc_employees" AS "VcManager" ON "VcManager"."id" = "vc_employees"."managerId" ' +
        'LEFT JOIN "vc_employees" AS "VcMentor" ON "VcMentor"."id" = "vc_employees"."mentorId" ' +
        'LEFT JOIN "vc_departments" ON "vc_departments"."id" = "vc_employees"."deptId" ' +
        'LEFT JOIN "vc_departments" AS "VcParentDept" ON "VcParentDept"."id" = "vc_departments"."parentId" ' +
        'WHERE ("VcManager"."address__city" = \'Paris\' OR "VcManager"."id" IS NULL)',
    );
  });

  it("selects FROM an upstream view's own columns, JSON leaf included", async () => {
    const sql = await createViewSql(fx.VcPeopleDepts);
    expect(sql).toContain(
      'FROM "vc_people" LEFT JOIN "vc_departments" ON "vc_departments"."id" = "vc_people"."deptId"',
    );
    expect(sql).toContain('"vc_people"."person_name" AS "name"');
    expect(sql).toContain('"vc_people"."address__city" AS "city"');
    expect(sql).toContain('"vc_people"."theme" AS "theme"');
    expect(sql).toMatch(/"vc_people"\."settings".*"level"/);
    expect(sql).toContain('WHERE "vc_people"."address__city" != \'Nowhere\'');
  });

  it("joins a view and reads an aggregate view's measure as a plain column", async () => {
    expect(await createViewSql(fx.VcDeptSizes)).toContain(
      'LEFT JOIN "vc_city_counts" ON "vc_city_counts"."city" = "vc_departments"."name"',
    );
    const big = await createViewSql(fx.VcBigCities);
    expect(big).toContain('FROM "vc_city_counts" WHERE "vc_city_counts"."people" >= 2');
    expect(big).not.toContain("GROUP BY");
  });
});
