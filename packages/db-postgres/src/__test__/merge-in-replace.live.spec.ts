import { describe, expect, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import type { AtscriptDbTable } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";
import { defineMergeInReplaceCases } from "../../../db/test-kit/merge-in-replace-cases";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips otherwise
// (see ./live-server). A merge-strategy object inside a replaced one keeps the
// children the patch leaves out (since 0.1.183) — the same rows as MongoDB.

const DB = "merge_in_replace";
const reachable = await pgReachable();

let space: DbSpace;
let items: AtscriptDbTable;

describe.skipIf(!reachable)("[postgres live] a merge-strategy object inside a replaced one", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const fx = await import("./fixtures/merge-in-replace.as");
    const driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
    space = new DbSpace(() => new PostgresAdapter(driver), { onClose: () => driver.close() });
    const result = await new SchemaSync(space).run([fx.MirItem], { force: true });
    expect(result.status).not.toBe("error");
    items = space.getTable(fx.MirItem);
  });

  afterAll(async () => {
    await space?.close();
    await dropPgDatabase(DB);
  });

  beforeEach(async () => {
    await items.deleteMany({});
  });

  defineMergeInReplaceCases(() => items);
});
