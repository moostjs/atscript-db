import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";
import {
  checkBoundedCascade,
  checkBoundedComposite,
  checkBoundedWrites,
  checkBulkValidation,
  checkCounterUpgrade,
  checkOnUpdateInc,
  type TBulkWriteTables,
} from "./bulk-writes-check";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips otherwise
// (see ./live-server). Bounded writes, `@db.onUpdate.inc` and the validated
// bulk payloads on a real engine (since 0.1.162).

const DB = "bulk_writes";
const reachable = await mysqlReachable();

let fx: Record<string, any>;
let driver: Mysql2Driver;
let space: DbSpace;
let t: TBulkWriteTables;

describe.skipIf(!reachable)(
  "[mysql live] bounded writes, @db.onUpdate.inc, validated bulk payloads",
  () => {
    beforeAll(async () => {
      await prepareFixtures();
      fx = await import("./fixtures/bulk-writes.as");
      driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
      space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
      t = {
        tasks: space.getTable(fx.BwTask),
        owners: space.getTable(fx.BwOwner),
        items: space.getTable(fx.BwItem),
      };
    });

    afterAll(async () => {
      await space?.close();
      await dropMysqlDatabase(DB);
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

    it("@db.onUpdate.inc moves on every write path; touchMany stamps @db.onUpdate.now", () =>
      checkOnUpdateInc(t));
    it("updateMany / replaceMany validate their payload", () => checkBulkValidation(t));
    it("bounded updateMany / deleteMany (native)", () => checkBoundedWrites(t));
    it("a bounded delete with a native FK cascade", () => checkBoundedCascade(t));
    it("bounded writes on a composite renamed key, NULL sort keys, a self-relation", () =>
      checkBoundedComposite(space.getTable(fx.BwBoard)));
    it("schema sync adds the counter to a populated table (backfilled 0)", () =>
      checkCounterUpgrade(space, SchemaSync, fx));
  },
);
