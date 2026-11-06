import { describe, beforeAll, afterAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";
import { defineRetainedRetypeCases } from "../../../db/test-kit/retained-retype-cases";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise (`ATSCRIPT_PG_TEST_URL` / `POSTGRES_TEST_URI`). A retype under a
// kept removed table's FK waits (see the kit); PostgreSQL would refuse it
// while the constraint is in place (incompatible key types). Since 0.1.173.

const DB = "retained_retype";

const reachable = await pgReachable();

let fx: Record<string, any>;
let driver: PgDriver;

describe.skipIf(!reachable)(
  "[postgres live] safe mode: a retype under a kept removed table's FK",
  () => {
    beforeAll(async () => {
      await prepareFixtures();
      fx = await import("./fixtures/retained-retype.as");
    });

    beforeEach(async () => {
      driver = new PgDriver(await recreatePgDatabase(DB));
    });

    afterEach(async () => {
      await driver?.close();
    });

    afterAll(async () => {
      await dropPgDatabase(DB);
    });

    defineRetainedRetypeCases({
      fx: () => fx,
      space: () => new DbSpace(() => new PostgresAdapter(driver)),
      columnType: async (table, column) =>
        (
          await driver.get<{ t: string }>(
            `SELECT data_type AS t FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
            [table, column],
          )
        )?.t,
      foreignKeys: (table) =>
        driver.all(
          `SELECT constraint_name FROM information_schema.table_constraints
            WHERE table_schema = current_schema() AND table_name = $1 AND constraint_type = 'FOREIGN KEY'`,
          [table],
        ),
      select: (table, columns) =>
        driver.all(`SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM ${table}`),
    });
  },
);
