import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips
// otherwise. A string column a foreign key references is VARCHAR; once the
// last reference goes (the foreign key, or the referencing table) it maps
// back to TEXT. Every step syncs without errors, stores its hash (the next
// run is up to date) and keeps the rows. Each step is a fresh space — a new
// deployment of the changed models.

const DB = "fk_reverse";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let driver: Mysql2Driver;

async function columnType(table: string, column: string): Promise<string | undefined> {
  const row = await driver.get<{ COLUMN_TYPE: string }>(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return row?.COLUMN_TYPE;
}

async function subPart(table: string, index: string): Promise<number | null | undefined> {
  const row = await driver.get<{ SUB_PART: number | null }>(
    `SELECT SUB_PART FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index],
  );
  return row === null ? undefined : row.SUB_PART;
}

async function foreignKeyColumns(table: string): Promise<string[]> {
  const rows = await driver.all<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [table],
  );
  return rows.map((r) => r.COLUMN_NAME);
}

async function count(table: string): Promise<number> {
  const row = await driver.get<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(row?.n);
}

/** Syncs `types` in a fresh space: no errors, then up to date. */
async function deploy(types: unknown[]): Promise<void> {
  const space = new DbSpace(() => new MysqlAdapter(driver));
  const result = await new SchemaSync(space).run(types as any[], { onError: "silent" });
  expect(result.entries.flatMap((e) => e.errors.map((m) => `${e.name}: ${m}`))).toEqual([]);
  expect(result.status).toBe("synced");
  const again = await new SchemaSync(new DbSpace(() => new MysqlAdapter(driver))).run(
    types as any[],
  );
  expect(again.status).toBe("up-to-date");
}

describe.skipIf(!reachable)("[mysql live] a referenced string column losing its references", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/fk-reverse.as");
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
  });

  afterAll(async () => {
    await driver?.close();
    await dropMysqlDatabase(DB);
  });

  it("referenced: VARCHAR on both sides, the foreign key in place", async () => {
    await deploy([fx.FrCat, fx.FrArtRef]);
    await driver.exec("INSERT INTO `fr_cats` (`slug`, `label`) VALUES ('s1', 'one')");
    await driver.exec("INSERT INTO `fr_arts` (`catSlug`, `note`) VALUES ('s1', 'a')");
    expect(await columnType("fr_cats", "slug")).toBe("varchar(255)");
    expect(await columnType("fr_arts", "catSlug")).toBe("varchar(255)");
    expect(await foreignKeyColumns("fr_arts")).toEqual(["catSlug"]);
  });

  it("the foreign key removed: both columns become TEXT, the unique index takes its prefix", async () => {
    await deploy([fx.FrCat, fx.FrArtPlain]);
    expect(await foreignKeyColumns("fr_arts")).toEqual([]);
    expect(await columnType("fr_cats", "slug")).toBe("text");
    expect(await columnType("fr_arts", "catSlug")).toBe("text");
    expect(await subPart("fr_cats", "atscript__unique__fr_slug_idx")).toBe(255);
    expect([await count("fr_cats"), await count("fr_arts")]).toEqual([1, 1]);
  });

  it("the foreign key back: VARCHAR again", async () => {
    await deploy([fx.FrCat, fx.FrArtRef]);
    expect(await columnType("fr_cats", "slug")).toBe("varchar(255)");
    expect(await foreignKeyColumns("fr_arts")).toEqual(["catSlug"]);
    expect(await subPart("fr_cats", "atscript__unique__fr_slug_idx")).toBeNull();
  });

  it("the referencing table removed: the referenced column becomes TEXT", async () => {
    await deploy([fx.FrCat]);
    expect(await columnType("fr_arts", "id")).toBeUndefined();
    expect(await columnType("fr_cats", "slug")).toBe("text");
    expect(await subPart("fr_cats", "atscript__unique__fr_slug_idx")).toBe(255);
    expect(await count("fr_cats")).toBe(1);
  });

  it("a unique string losing @expect.maxLength becomes TEXT with a prefixed index", async () => {
    await deploy([fx.FrCat, fx.FrCodeSized]);
    await driver.exec("INSERT INTO `fr_codes` (`code`) VALUES ('c1')");
    expect(await subPart("fr_codes", "atscript__unique__fr_code_idx")).toBeNull();
    await deploy([fx.FrCat, fx.FrCodeText]);
    expect(await columnType("fr_codes", "code")).toBe("text");
    expect(await subPart("fr_codes", "atscript__unique__fr_code_idx")).toBe(255);
    expect(await count("fr_codes")).toBe(1);
  });
});
