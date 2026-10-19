import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";
import {
  checkCounterUpgrade,
  defineBulkWritesCases,
  type TBulkWriteTables,
} from "../../../db/test-kit/bulk-writes-cases";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips otherwise
// (see ./live-server). Bounded writes, `@db.onUpdate.inc` and the validated
// bulk payloads on a real engine (since 0.1.162).

const DB = "bulk_writes";
const reachable = await pgReachable();

let fx: Record<string, any>;
let driver: PgDriver;
let space: DbSpace;
let t: TBulkWriteTables;

describe.skipIf(!reachable)(
  "[postgres live] bounded writes, @db.onUpdate.inc, validated bulk payloads",
  () => {
    beforeAll(async () => {
      await prepareFixtures();
      fx = await import("./fixtures/bulk-writes.as");
      driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
      space = new DbSpace(() => new PostgresAdapter(driver), { onClose: () => driver.close() });
      t = {
        tasks: space.getTable(fx.BwTask),
        owners: space.getTable(fx.BwOwner),
        items: space.getTable(fx.BwItem),
      };
    });

    afterAll(async () => {
      await space?.close();
      await dropPgDatabase(DB);
    });

    beforeEach(async () => {
      const result = await new SchemaSync(space).run(
        [fx.BwTask, fx.BwOwner, fx.BwItem, fx.BwBoard],
        {
          force: true,
        },
      );
      expect(result.status).not.toBe("error");
      await t.items.deleteMany({});
      await t.owners.deleteMany({});
      await t.tasks.deleteMany({});
      const boards = space.getTable(fx.BwBoard);
      await boards.updateMany({}, { parentOrg: null, parentCode: null } as never);
      await boards.deleteMany({});
    });

    defineBulkWritesCases({
      tables: () => t,
      boards: () => space.getTable(fx.BwBoard),
      bounded: "native",
      cascade: "native",
    });
    it("schema sync adds the counter to a populated table (backfilled 0)", () =>
      checkCounterUpgrade(space, SchemaSync, fx));
  },
);
