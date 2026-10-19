import { describe, beforeAll, afterAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";
import { defineDefaultConvergenceCases } from "../../../db/test-kit/default-convergence-cases";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise. Override with `ATSCRIPT_PG_TEST_URL` (or `POSTGRES_TEST_URI`).
// A forced re-sync converges for every default kind: before 0.1.162 booleans,
// `1.0`, `10.50` and jsonb (`{"a": 1}`) re-diffed on every forced run.

const DB = "default_convergence";

const reachable = await pgReachable();

let fx: Record<string, any>;
let driver: PgDriver;
let space: DbSpace;

describe.skipIf(!reachable)("[postgres live] forced sync converges over every default kind", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/default-kinds.as");
  });

  beforeEach(async () => {
    driver = new PgDriver(await recreatePgDatabase(DB));
    space = new DbSpace(() => new PostgresAdapter(driver), { onClose: () => driver.close() });
  });

  afterEach(async () => {
    await space?.close();
  });

  afterAll(async () => {
    await dropPgDatabase(DB);
  });

  defineDefaultConvergenceCases(() => ({
    fx,
    space,
    indexes: true,
    dropMemberFk: async () => {
      const [fk] = await driver.all<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'dk_members'::regclass AND contype = 'f'`,
      );
      await driver.exec(`ALTER TABLE "dk_members" DROP CONSTRAINT "${fk!.conname}"`);
    },
    driftTeamNameDefault: () =>
      driver.exec(`ALTER TABLE "dk_teams" ALTER COLUMN "name" SET DEFAULT 'zz'`),
  }));
});
