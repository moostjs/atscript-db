import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { AtscriptDbTable, DbError } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

let VersionedRenamedTable: any;

/**
 * `@db.column 'row_version'` on the logical `version` field (recording driver).
 * The table API speaks `version` (`$cas` key, touch keys); every statement the
 * adapter emits targets the PHYSICAL `row_version` column via
 * `versionColumnPhysical`. ≤ 0.1.140 let a body `version` reach the SET list
 * next to the auto-bump (`SET row_version = ?, row_version = row_version + 1`).
 */
describe("MysqlAdapter — renamed version column", () => {
  let driver: ReturnType<typeof createMockDriver>;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    VersionedRenamedTable = (await import("./fixtures/version-occ.as")).VersionedRenamedTable;
  });

  beforeEach(() => {
    driver = createMockDriver({ getResult: { cnt: 1 }, runResult: { affectedRows: 1 } });
    table = new AtscriptDbTable(VersionedRenamedTable, new MysqlAdapter(driver));
  });

  const updates = () =>
    driver.calls.filter((c) => c.method === "run" && c.sql.startsWith("UPDATE"));

  it("exposes logical versionColumn and physical versionColumnPhysical", () => {
    expect(table.versionColumn).toBe("version");
    expect(table.versionColumnPhysical).toBe("row_version");
  });

  it("updateOne with `$cas: { version }` bumps and CASes on the physical column", async () => {
    await table.updateOne({ id: 1, name: "B", $cas: { version: 3 } } as any);
    const [stmt] = updates();
    expect(updates()).toHaveLength(1);
    expect(stmt!.sql).toContain("`row_version` = `row_version` + 1");
    expect(stmt!.sql).toMatch(/`row_version` = \?/);
    expect(stmt!.sql).not.toContain("`version`");
    expect(stmt!.params).toContain(3);
  });

  it("replaceOne never NULLs the physical version column and bumps it", async () => {
    await table.replaceOne({ id: 1, name: "R", $cas: { version: 2 } } as any);
    const [stmt] = updates();
    expect(stmt!.sql).toContain("`row_version` = `row_version` + 1");
    expect(stmt!.sql).not.toMatch(/`row_version` = (NULL|\?),/);
    expect(stmt!.params).toContain(2);
  });

  it("rejects a direct write to the logical version field before any statement", async () => {
    const err = await table.updateOne({ id: 1, version: 9 } as any).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("VERSION_COLUMN_WRITE");
    expect(updates()).toHaveLength(0);
  });

  it("touchMany keys carry the logical field; the predicate uses the physical column", async () => {
    await table.touchMany([{ id: 1, version: 4 }] as any);
    const count = driver.calls.find((c) => c.method === "get" && c.sql.includes("COUNT(*)"));
    expect(count!.sql).toMatch(/`id` = \? AND `row_version` = \?/);
    expect(count!.params).toEqual([1, 4]);
  });
});
