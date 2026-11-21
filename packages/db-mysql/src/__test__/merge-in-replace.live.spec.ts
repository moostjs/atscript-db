import { describe, expect, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import type { AtscriptDbTable } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";
import { defineMergeInReplaceCases } from "../../../db/test-kit/merge-in-replace-cases";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips otherwise
// (see ./live-server). A merge-strategy object inside a replaced one keeps the
// children the patch leaves out (since 0.1.183) — the same rows as MongoDB.

const DB = "merge_in_replace";
const reachable = await mysqlReachable();

let space: DbSpace;
let items: AtscriptDbTable;

describe.skipIf(!reachable)("[mysql live] a merge-strategy object inside a replaced one", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const fx = await import("./fixtures/merge-in-replace.as");
    const driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
    const result = await new SchemaSync(space).run([fx.MirItem], { force: true });
    expect(result.status).not.toBe("error");
    items = space.getTable(fx.MirItem);
  });

  afterAll(async () => {
    await space?.close();
    await dropMysqlDatabase(DB);
  });

  beforeEach(async () => {
    await items.deleteMany({});
  });

  defineMergeInReplaceCases(() => items);
});
