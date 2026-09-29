import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import type { TDbFieldMeta } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

// `@db.column.derived` on MySQL (since 0.1.141): VIRTUAL generated columns
// in CREATE TABLE and ADD COLUMN, and `EXTRA` introspection.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/derived.as");
});

const execs = (driver: ReturnType<typeof createMockDriver>) =>
  driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);

describe("MysqlAdapter — derived columns", () => {
  it("CREATE TABLE renders each derived field as a typed VIRTUAL generated column", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new MysqlAdapter(driver));
    await space.getTable(fx.DvOrder).dbAdapter.ensureTable();
    const create = execs(driver).find((s) => s.startsWith("CREATE TABLE"))!;
    expect(create).toContain(
      '`customerId` VARCHAR(255) GENERATED ALWAYS AS (CASE JSON_TYPE(JSON_EXTRACT(`payload`, \'$."customer"."id"\')) WHEN \'STRING\' THEN JSON_UNQUOTE(JSON_EXTRACT(`payload`, \'$."customer"."id"\')) END) VIRTUAL',
    );
    expect(create).toMatch(
      /`vip` TINYINT\(1\) GENERATED ALWAYS AS \(.*`payload`.*"customer"."vip".*\) VIRTUAL/,
    );
    expect(create).toMatch(/`amount` DOUBLE GENERATED ALWAYS AS \(.*"total".*\) VIRTUAL/);
    expect(create).toMatch(
      /`region_code` VARCHAR\(255\) GENERATED ALWAYS AS \(.*`meta_json`.*"region".*\) VIRTUAL/,
    );
    expect(create).toMatch(/`tier` VARCHAR\(255\) COLLATE utf8mb4_general_ci GENERATED ALWAYS AS/);
    // Never NOT NULL / DEFAULT on a generated column
    expect(create).not.toMatch(/GENERATED ALWAYS AS \([^\n]*\) VIRTUAL (NOT NULL|DEFAULT)/);
  });

  it("ADD COLUMN uses the same definition", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new MysqlAdapter(driver));
    const table = space.getTable(fx.DvSyncV1);
    const field = table.fieldDescriptors.find((f: TDbFieldMeta) => f.path === "customerId")!;
    await table.dbAdapter.syncColumns!({
      added: [field],
      removed: [],
      renamed: [],
      typeChanged: [],
      nullableChanged: [],
      defaultChanged: [],
      conflicts: [],
    });
    expect(execs(driver).filter((s) => s.startsWith("ALTER"))).toEqual([
      expect.stringMatching(
        /^ALTER TABLE `dv_sync` ADD COLUMN `customerId` VARCHAR\(255\) GENERATED ALWAYS AS \(.*\) VIRTUAL$/,
      ),
    ]);
  });

  it("introspection flags VIRTUAL / STORED GENERATED columns", async () => {
    const driver = createMockDriver({
      all: [
        [
          "INFORMATION_SCHEMA.COLUMNS",
          [
            {
              COLUMN_NAME: "id",
              COLUMN_TYPE: "int",
              IS_NULLABLE: "NO",
              IS_PK: 1,
              COLUMN_DEFAULT: null,
              EXTRA: "",
            },
            {
              COLUMN_NAME: "payload",
              COLUMN_TYPE: "json",
              IS_NULLABLE: "NO",
              IS_PK: 0,
              COLUMN_DEFAULT: null,
              EXTRA: "",
            },
            {
              COLUMN_NAME: "customerId",
              COLUMN_TYPE: "varchar(255)",
              IS_NULLABLE: "YES",
              IS_PK: 0,
              COLUMN_DEFAULT: null,
              EXTRA: "VIRTUAL GENERATED",
            },
            {
              COLUMN_NAME: "other",
              COLUMN_TYPE: "varchar(255)",
              IS_NULLABLE: "YES",
              IS_PK: 0,
              COLUMN_DEFAULT: null,
              EXTRA: "STORED GENERATED",
            },
            {
              COLUMN_NAME: "updatedAt",
              COLUMN_TYPE: "timestamp",
              IS_NULLABLE: "YES",
              IS_PK: 0,
              COLUMN_DEFAULT: null,
              EXTRA: "on update CURRENT_TIMESTAMP",
            },
          ],
        ],
      ],
    });
    const space = new DbSpace(() => new MysqlAdapter(driver));
    const columns = await space.getTable(fx.DvSyncV1).dbAdapter.getExistingColumns!();
    expect(columns.map((c) => [c.name, c.generated])).toEqual([
      ["id", undefined],
      ["payload", undefined],
      ["customerId", true],
      ["other", true],
      ["updatedAt", undefined],
    ]);
  });
});
