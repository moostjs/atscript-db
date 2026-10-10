import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// A number column that becomes `TIMESTAMP` (`number.timestamp` →
// `number.timestamp.created`, which carries `@db.default.now` since 0.1.155):
// MODIFY would read epoch ms as YYYYMMDDhhmmss, so the values go through a
// temp column converted from epoch ms.

let TsAfter: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ TsAfter } = await import("./fixtures/embedded-id.as"));
});

/** The ALTER / UPDATE statements run (not the strict-session `SET`s around them). */
const ddl = (driver: ReturnType<typeof createMockDriver>) =>
  driver.calls
    .filter((c) => c.method === "exec" && /^(ALTER|UPDATE)/.test(c.sql))
    .map((c) => c.sql);

function makeTable(overrides?: Parameters<typeof createMockDriver>[0]) {
  const driver = createMockDriver(overrides);
  const adapter = new MysqlAdapter(driver);
  const table = new AtscriptDbTable(TsAfter, adapter);
  const field = table.fieldDescriptors.find((f) => f.path === "createdAt")!;
  return { driver, adapter, field };
}

describe("[mysql] epoch-ms number column → TIMESTAMP", () => {
  it("converts through a temp column, then applies the full definition", async () => {
    const { driver, adapter, field } = makeTable();
    await adapter.syncColumns({
      added: [],
      renamed: [],
      typeChanged: [{ field, existingType: "DOUBLE" }],
      nullableChanged: [],
      defaultChanged: [],
    } as any);
    expect(ddl(driver)).toEqual([
      "ALTER TABLE `ts_upgrade` ADD COLUMN `createdAt__ts_mig` TIMESTAMP NULL AFTER `createdAt`",
      "UPDATE `ts_upgrade` SET `createdAt__ts_mig` = DATE_ADD(CAST('1970-01-01 00:00:00' AS DATETIME(6)), INTERVAL FLOOR(`createdAt` / 1000) * 1000000 MICROSECOND) WHERE `createdAt` IS NOT NULL",
      "ALTER TABLE `ts_upgrade` DROP COLUMN `createdAt`",
      "ALTER TABLE `ts_upgrade` RENAME COLUMN `createdAt__ts_mig` TO `createdAt`",
      "ALTER TABLE `ts_upgrade` MODIFY COLUMN `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
    ]);
  });

  it("a value the type cannot hold fails with the original column kept", async () => {
    const { driver, adapter, field } = makeTable({
      execError: (sql) =>
        sql.startsWith("UPDATE") ? new Error("Incorrect datetime value") : undefined,
    });
    await expect(
      adapter.syncColumns({
        added: [],
        renamed: [],
        typeChanged: [{ field, existingType: "DOUBLE" }],
        nullableChanged: [],
        defaultChanged: [],
      } as any),
    ).rejects.toThrow(/Incorrect datetime value/);
    const execs = ddl(driver);
    expect(execs.at(-1)).toBe("ALTER TABLE `ts_upgrade` DROP COLUMN `createdAt__ts_mig`");
    expect(execs.some((s) => s.includes("DROP COLUMN `createdAt`"))).toBe(false);
  });

  it("a drop the engine refuses fails with the original column kept", async () => {
    const { driver, adapter, field } = makeTable({
      execError: (sql) =>
        sql.endsWith("DROP COLUMN `createdAt`") ? new Error("Duplicate entry") : undefined,
    });
    await expect(
      adapter.syncColumns({
        added: [],
        renamed: [],
        typeChanged: [{ field, existingType: "DOUBLE" }],
        nullableChanged: [],
        defaultChanged: [],
      } as any),
    ).rejects.toThrow(/Duplicate entry/);
    expect(ddl(driver).at(-1)).toBe("ALTER TABLE `ts_upgrade` DROP COLUMN `createdAt__ts_mig`");
  });

  it("a primary-key column is refused before any DDL", async () => {
    const { driver, adapter, field } = makeTable();
    await expect(
      adapter.syncColumns({
        added: [],
        renamed: [],
        typeChanged: [{ field: { ...field, isPrimaryKey: true }, existingType: "DOUBLE" }],
        nullableChanged: [],
        defaultChanged: [],
      } as any),
    ).rejects.toThrow(/primary-key column "createdAt"/);
    expect(ddl(driver)).toEqual([]);
  });

  it("a text column: numeric text is epoch ms, other text a datetime", async () => {
    // the column atscript-db <= 0.1.154 created for `number.timestamp.created | null`
    const { driver, adapter, field } = makeTable();
    await adapter.syncColumns({
      added: [],
      renamed: [],
      typeChanged: [{ field, existingType: "TEXT" }],
      nullableChanged: [],
      defaultChanged: [],
    } as any);
    expect(ddl(driver)[1]).toBe(
      "UPDATE `ts_upgrade` SET `createdAt__ts_mig` = CASE WHEN `createdAt` REGEXP '^[0-9]+([.][0-9]+)?$' THEN DATE_ADD(CAST('1970-01-01 00:00:00' AS DATETIME(6)), INTERVAL FLOOR(`createdAt` / 1000) * 1000000 MICROSECOND) ELSE CAST(`createdAt` AS DATETIME(6)) END WHERE `createdAt` IS NOT NULL",
    );
    expect(ddl(driver)).toHaveLength(5);
  });

  it("another column type keeps the plain MODIFY", async () => {
    const { driver, adapter, field } = makeTable();
    await adapter.syncColumns({
      added: [],
      renamed: [],
      typeChanged: [{ field, existingType: "DATE" }],
      nullableChanged: [],
      defaultChanged: [],
    } as any);
    expect(ddl(driver)).toEqual([
      "ALTER TABLE `ts_upgrade` MODIFY COLUMN `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
    ]);
  });
});
