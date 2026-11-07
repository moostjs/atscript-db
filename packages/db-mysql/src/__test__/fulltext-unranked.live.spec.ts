import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips
// otherwise (CI has no server). Override with `ATSCRIPT_MYSQL_TEST_URL` (an admin
// connection; the spec creates and drops its own `fulltext_unranked` database).
// `$rank: false` (since 0.1.175): MATCH only filters — `$sort`, else primary-key order.

const DB = "fulltext_unranked";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let space: DbSpace;

const ids = (rows: unknown[]) => (rows as Array<{ id: number }>).map((r) => r.id);

describe.skipIf(!reachable)("[mysql live] $rank: false", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/fulltext-rank.as");
    const driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
    const result = await new SchemaSync(space).run([fx.FtPlain], { force: true });
    expect(result.status).toBe("synced");
    await space.getTable(fx.FtPlain).insertMany([
      { id: 1, title: "notes", body: "a long text that mentions a kitten once among many words" },
      { id: 2, title: "kitten", body: "kitten kitten" },
    ] as never);
  });

  afterAll(async () => {
    await space?.close();
    await dropMysqlDatabase(DB);
  });

  it("primary-key order; ranked, the better match first; $sort still wins", async () => {
    const table = space.getTable(fx.FtPlain);
    expect(ids(await table.search("kitten", { filter: {}, controls: {} }))).toEqual([2, 1]);
    const unranked = { filter: {}, controls: { $rank: false } } as never;
    expect(ids(await table.search("kitten", unranked))).toEqual([1, 2]);
    const page = await table.searchWithCount("kitten", unranked);
    expect([ids(page.data), page.count]).toEqual([[1, 2], 2]);
    const sorted = { filter: {}, controls: { $rank: false, $sort: { id: -1 } } } as never;
    expect(ids(await table.search("kitten", sorted))).toEqual([2, 1]);
  });
});
