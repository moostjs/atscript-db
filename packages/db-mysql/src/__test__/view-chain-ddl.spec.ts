import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

// Views over views and join aliases (since 0.1.141): the CREATE VIEW DDL the
// adapter issues — FROM a view, JOIN a view, JOIN `t` AS `Alias`. Sync
// ordering (upstream-first creates, dependents-first drops) is the core's.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-chain.as");
});

async function createViewSql(type: any): Promise<string> {
  const driver = createMockDriver();
  const space = new DbSpace(() => new MysqlAdapter(driver));
  await space.getView(type).dbAdapter.ensureTable();
  const ddl = driver.calls
    .filter((c) => c.method === "exec" && c.sql.includes("VIEW"))
    .map((c) => c.sql);
  expect(ddl).toHaveLength(1);
  return ddl[0];
}

describe("MysqlAdapter — views over views and join aliases", () => {
  it("renders aliased joins as JOIN ... AS and addresses them by the alias", async () => {
    const sql = await createViewSql(fx.VcStaff);
    expect(sql).toContain(
      "LEFT JOIN `vc_employees` AS `VcManager` ON `VcManager`.`id` = `vc_employees`.`managerId`",
    );
    expect(sql).toContain(
      "LEFT JOIN `vc_employees` AS `VcMentor` ON `VcMentor`.`id` = `vc_employees`.`mentorId`",
    );
    expect(sql).toContain(
      "LEFT JOIN `vc_departments` ON `vc_departments`.`id` = `vc_employees`.`deptId`",
    );
    expect(sql).toContain(
      "LEFT JOIN `vc_departments` AS `VcParentDept` ON `VcParentDept`.`id` = `vc_departments`.`parentId`",
    );
    expect(sql).toContain("`VcManager`.`full_name` AS `managerName`");
    expect(sql).toContain("`VcParentDept`.`name` AS `parentDeptName`");
    expect(sql).toContain(
      "WHERE (`VcManager`.`address__city` = 'Paris' OR `VcManager`.`id` IS NULL)",
    );
  });

  it("selects FROM an upstream view's own columns, JSON leaf included", async () => {
    const sql = await createViewSql(fx.VcPeopleDepts);
    expect(sql).toContain(
      "FROM `vc_people` LEFT JOIN `vc_departments` ON `vc_departments`.`id` = `vc_people`.`deptId`",
    );
    expect(sql).toContain("`vc_people`.`person_name` AS `name`");
    expect(sql).toContain("`vc_people`.`address__city` AS `city`");
    expect(sql).toContain("`vc_people`.`theme` AS `theme`");
    expect(sql).toMatch(/`vc_people`\.`settings`.*level/);
  });

  it("joins a view and reads an aggregate view's measure as a plain column", async () => {
    expect(await createViewSql(fx.VcDeptSizes)).toContain(
      "LEFT JOIN `vc_city_counts` ON `vc_city_counts`.`city` = `vc_departments`.`name`",
    );
    const big = await createViewSql(fx.VcBigCities);
    expect(big).toContain("FROM `vc_city_counts` WHERE `vc_city_counts`.`people` >= 2");
    expect(big).not.toContain("GROUP BY");
  });
});
