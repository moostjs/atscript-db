import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { planSchema, syncSchema } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import {
  mysqlReachable,
  mysqlDbUrl,
  recreateMysqlDatabase,
  dropMysqlDatabase,
} from "./live-server";

// Live DDL against a real server is slow under the parallel workspace run.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated (see relation-filter.live.spec.ts): a foreign key into a table
// of another database (`@db.schema`) — `REFERENCES` must be qualified.

const DB = "relfix_xs_main";
const OTHER = "relfix_xs";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let driver: Mysql2Driver;
let space: DbSpace;
const types = () => [fx.XsOwner, fx.XsItem, fx.XsPlain];

describe.skipIf(!reachable)("[mysql live] cross-database FKs", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/cross-schema-live.as");
    for (const db of [DB, OTHER]) await recreateMysqlDatabase(db);
    driver = new Mysql2Driver(mysqlDbUrl(DB));
    space = new DbSpace(() => new MysqlAdapter(driver));
  });

  afterAll(async () => {
    await driver?.close();
    for (const db of [DB, OTHER]) await dropMysqlDatabase(db);
  });

  it("creates a table whose FK targets another database; a second sync is a no-op", async () => {
    const result = await syncSchema(space, types());
    expect(result.entries.filter((e) => e.status === "error")).toEqual([]);
    expect(result.status).toBe("synced");
    const fks = await driver.all<{ db: string; tbl: string }>(
      `SELECT REFERENCED_TABLE_SCHEMA AS db, REFERENCED_TABLE_NAME AS tbl
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'xs_items' AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [DB],
    );
    expect(fks).toEqual([{ db: OTHER, tbl: "xs_owners" }]);
    expect((await syncSchema(space, types())).status).toBe("up-to-date");
    const plan = await planSchema(space, types(), { force: true });
    expect(
      plan.entries.filter((e) => e.status !== "in-sync").map((e) => [e.name, e.status]),
    ).toEqual([]);
  });

  it("predicates and the native cascade work across the databases", async () => {
    await space.getTable(fx.XsOwner).insertMany([
      { id: "o1", name: "A" },
      { id: "o2", name: "B" },
    ]);
    await space.getTable(fx.XsItem).insertMany([
      { id: 1, title: "x", ownerId: "o1" },
      { id: 2, title: "y", ownerId: "o2" },
    ]);
    const items = space.getTable(fx.XsItem);
    expect(
      (await items.findMany({ filter: { owner: { $some: { name: "A" } } } } as any)).map(
        (r: any) => r.id,
      ),
    ).toEqual([1]);
    await space.getTable(fx.XsOwner).deleteMany({ items: { $some: { title: "y" } } } as any);
    expect((await items.findMany({ filter: {} } as any)).map((r: any) => r.id)).toEqual([1]);
  });
});
