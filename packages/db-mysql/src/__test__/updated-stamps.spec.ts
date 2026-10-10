import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable, DbSpace } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// `number.timestamp.updated` (atscript 0.1.106) is a `@db.default.now` column
// (TIMESTAMP DEFAULT CURRENT_TIMESTAMP, whole seconds) that every UPDATE
// statement sets — the SDK writes the time, as on every adapter (no native
// ON UPDATE: it would fire on the sync's own data moves, and not when a
// patch leaves the row's values unchanged).

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/updated-stamps.as");
});

describe("[mysql] number.timestamp.updated", () => {
  it("CREATE TABLE: TIMESTAMP DEFAULT CURRENT_TIMESTAMP, no ON UPDATE", async () => {
    const driver = createMockDriver();
    await new DbSpace(() => new MysqlAdapter(driver)).getTable(fx.UpdDoc).ensureTable();
    const create = driver.calls.map((c) => c.sql).find((s) => s.startsWith("CREATE TABLE"))!;
    expect(create).toContain(
      "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, `aliased` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, `nullable` TIMESTAMP DEFAULT CURRENT_TIMESTAMP, `audit__note` TEXT, `audit__at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    expect(create).not.toContain("ON UPDATE");
  });

  it("an earlier DOUBLE column converts from epoch ms through a temp column", async () => {
    const driver = createMockDriver();
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(fx.UpdAfter, adapter);
    const field = table.fieldDescriptors.find((f) => f.path === "updatedAt")!;
    await adapter.syncColumns({
      added: [],
      renamed: [],
      typeChanged: [{ field, existingType: "DOUBLE" }],
      nullableChanged: [],
      defaultChanged: [],
    } as any);
    expect(
      driver.calls
        .filter((c) => c.method === "exec" && /^(ALTER|UPDATE)/.test(c.sql))
        .map((c) => c.sql),
    ).toEqual([
      "ALTER TABLE `upd_upgrade` ADD COLUMN `updatedAt__ts_mig` TIMESTAMP NULL AFTER `updatedAt`",
      "UPDATE `upd_upgrade` SET `updatedAt__ts_mig` = DATE_ADD(CAST('1970-01-01 00:00:00' AS DATETIME(6)), INTERVAL FLOOR(`updatedAt` / 1000) * 1000000 MICROSECOND) WHERE `updatedAt` IS NOT NULL",
      "ALTER TABLE `upd_upgrade` DROP COLUMN `updatedAt`",
      "ALTER TABLE `upd_upgrade` RENAME COLUMN `updatedAt__ts_mig` TO `updatedAt`",
      "ALTER TABLE `upd_upgrade` MODIFY COLUMN `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
    ]);
  });

  it("a filtered updateMany sets the time in the UPDATE statement", async () => {
    const driver = createMockDriver();
    const table = new DbSpace(() => new MysqlAdapter(driver)).getTable(fx.UpdDoc);
    const before = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    await table.updateMany({ title: "a" } as any, { title: "b", updatedAt: 1 } as any);
    const update = driver.calls.find((c) => c.sql.startsWith("UPDATE"))!;
    expect(update.sql).toBe(
      "UPDATE `upd_docs` SET `title` = ?, `updatedAt` = ?, `aliased` = ?, `nullable` = ? WHERE `title` = ?",
    );
    const [, at, aliased, nullable] = update.params as string[];
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(`${at!.replace(" ", "T").slice(0, 19)}.000Z` >= before).toBe(true);
    expect([aliased, nullable]).toEqual([at, at]);
  });
});
