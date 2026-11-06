import { describe, beforeAll, afterAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";
import { defineRetainedRetypeCases } from "../../../db/test-kit/retained-retype-cases";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL when one is reachable, skips
// otherwise (`ATSCRIPT_MYSQL_TEST_URL` / `MYSQL_TEST_URI`). A retype under a
// kept removed table's FK waits (see the kit); MySQL would refuse it while
// the constraint is in place (ER 3780). Since 0.1.173.

const DB = "retained_retype";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let driver: Mysql2Driver;

describe.skipIf(!reachable)(
  "[mysql live] safe mode: a retype under a kept removed table's FK",
  () => {
    beforeAll(async () => {
      await prepareFixtures();
      fx = await import("./fixtures/retained-retype.as");
    });

    beforeEach(async () => {
      driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    });

    afterEach(async () => {
      await driver?.close();
    });

    afterAll(async () => {
      await dropMysqlDatabase(DB);
    });

    defineRetainedRetypeCases({
      fx: () => fx,
      space: () => new DbSpace(() => new MysqlAdapter(driver)),
      columnType: async (table, column) =>
        (
          await driver.get<{ t: string }>(
            `SELECT COLUMN_TYPE AS t FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [table, column],
          )
        )?.t,
      foreignKeys: (table) =>
        driver.all(
          `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
          [table],
        ),
      select: (table, columns) => driver.all(`SELECT ${columns.join(", ")} FROM ${table}`),
    });
  },
);
