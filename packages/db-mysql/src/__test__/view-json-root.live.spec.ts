import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures, createMockDriver } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";

// A view field over a whole primitive @db.json field reads the typed JSON root
// value — `9`, not the JSON text — and sorts / filters by it (since 0.1.162).
// The live suite runs when a server is reachable (see live-server.ts) and
// creates / drops its own database.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const DB = "r17_json_root_mysql";
const reachable = await mysqlReachable();

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-json-root.as");
});

describe("MysqlAdapter — view over a primitive @db.json field", () => {
  it("extracts the typed JSON root in the view DDL", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new MysqlAdapter(driver));
    await space.getView(fx.VjrItemView).dbAdapter.ensureTable();
    const ddl = driver.calls
      .filter((c) => c.method === "exec" && c.sql.includes("VIEW"))
      .map((c) => c.sql);
    expect(ddl).toHaveLength(1);
    expect(ddl[0]).toContain("CASE WHEN JSON_TYPE(JSON_EXTRACT(`vjr_items`.`score`, '$')) IN (");
  });
});

describe.skipIf(!reachable)("[mysql live] view over a primitive @db.json field", () => {
  let driver: Mysql2Driver;
  let space: DbSpace;

  beforeAll(async () => {
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver));
    const result = await syncSchema(space, [fx.VjrItem, fx.VjrItemView]);
    expect(result.status).toBe("synced");
    await space
      .getTable(fx.VjrItem as never)
      .insertMany([
        { id: 1, score: 9, label: "b", active: true },
        { id: 2, score: 10, label: "a", active: false },
        { id: 3, score: 2.5, label: "c", active: true },
        { id: 4 },
      ] as never);
  });

  afterAll(async () => {
    await driver?.close();
    await dropMysqlDatabase(DB);
  });

  const view = () => space.getView(fx.VjrItemView as never) as any;
  const ids = async (query: { filter?: object; controls?: object }) =>
    (
      (await view().findMany({
        filter: query.filter ?? {},
        controls: { $select: ["id"], ...query.controls },
      })) as Array<{ id: number }>
    ).map((r) => r.id);

  it("returns the typed values", async () => {
    expect(await view().findMany({ filter: {}, controls: { $sort: { id: 1 } } })).toEqual([
      { id: 1, score: 9, label: "b", active: true },
      { id: 2, score: 10, label: "a", active: false },
      { id: 3, score: 2.5, label: "c", active: true },
      { id: 4, score: null, label: null, active: null },
    ]);
  });

  it("sorts and filters by the typed value", async () => {
    expect(
      await ids({ filter: { score: { $exists: true } }, controls: { $sort: { score: 1 } } }),
    ).toEqual([3, 1, 2]);
    expect(
      await ids({ filter: { score: { $gt: 5 } }, controls: { $sort: { score: -1 } } }),
    ).toEqual([2, 1]);
    expect(await ids({ filter: { active: true }, controls: { $sort: { id: 1 } } })).toEqual([1, 3]);
    expect(
      await ids({ filter: { label: { $exists: true } }, controls: { $sort: { label: 1 } } }),
    ).toEqual([2, 1, 3]);
  });
});
