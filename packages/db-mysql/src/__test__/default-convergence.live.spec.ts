import { describe, beforeAll, afterAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";
import { defineDefaultConvergenceCases } from "../../../db/test-kit/default-convergence-cases";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips
// otherwise. Override with `ATSCRIPT_MYSQL_TEST_URL` (or `MYSQL_TEST_URI`; an
// admin connection — the spec creates and drops its own database).
// A forced re-sync converges for every default kind: before 0.1.162 the
// expression defaults of TEXT / JSON columns (`_utf8mb4\'[]\'`), booleans,
// `1.0` and DECIMAL scale (`0.00`) re-diffed and re-ran MODIFY COLUMN forever.

const DB = "default_convergence";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let driver: Mysql2Driver;
let space: DbSpace;

describe.skipIf(!reachable)("[mysql live] forced sync converges over every default kind", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/default-kinds.as");
  });

  beforeEach(async () => {
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
  });

  afterEach(async () => {
    await space?.close();
  });

  afterAll(async () => {
    await dropMysqlDatabase(DB);
  });

  defineDefaultConvergenceCases(() => ({
    fx,
    space,
    indexes: true,
    dropMemberFk: async () => {
      const [fk] = await driver.all<{ CONSTRAINT_NAME: string }>(
        `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dk_members'
            AND REFERENCED_TABLE_NAME IS NOT NULL`,
      );
      await driver.exec(`ALTER TABLE \`dk_members\` DROP FOREIGN KEY \`${fk!.CONSTRAINT_NAME}\``);
    },
    driftTeamNameDefault: () =>
      driver.exec("ALTER TABLE `dk_teams` MODIFY COLUMN `name` TEXT NOT NULL DEFAULT ('zz')"),
  }));
});
