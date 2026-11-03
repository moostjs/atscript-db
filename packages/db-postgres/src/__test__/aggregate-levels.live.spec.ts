import { describe, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { AL_ROWS, defineAggregateLevelCases } from "../../../db/test-kit/aggregate-levels-cases";
import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise. The shared case table of countDistinct over a field list,
// conditional aggregates and two-level aggregates (since 0.1.168).

const DB = "agglevels_live";
const reachable = await pgReachable();

let fx: Record<string, any>;
let driver: PgDriver;
let space: DbSpace;

describe.skipIf(!reachable)("[postgres live] aggregate levels", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/agg-levels.as");
    driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
    space = new DbSpace(() => new PostgresAdapter(driver));
    const result = await syncSchema(space, [fx.AlSale]);
    expect(result.status).toBe("synced");
    await space.getTable(fx.AlSale).insertMany(AL_ROWS as never);
  });

  afterAll(async () => {
    await driver?.close();
    await dropPgDatabase(DB);
  });

  defineAggregateLevelCases("PostgreSQL", () => space.getTable(fx.AlSale));
});
