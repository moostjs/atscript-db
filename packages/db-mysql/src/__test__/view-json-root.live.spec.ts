import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures, createMockDriver } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";
import { VJR_ITEMS, defineViewJsonRootCases } from "../../../db/test-kit/view-json-root-cases";

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
    await space.getTable(fx.VjrItem as never).insertMany(VJR_ITEMS);
  });

  afterAll(async () => {
    await driver?.close();
    await dropMysqlDatabase(DB);
  });

  defineViewJsonRootCases({ view: () => space.getView(fx.VjrItemView as never) });
});
