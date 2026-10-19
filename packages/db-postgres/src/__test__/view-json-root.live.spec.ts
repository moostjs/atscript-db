import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures, createMockDriver } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";
import { VJR_ITEMS, defineViewJsonRootCases } from "../../../db/test-kit/view-json-root-cases";

// A view field over a whole primitive @db.json field reads the typed JSON root
// value — `9`, not the JSON text — and sorts / filters by it (since 0.1.162).
// The live suite runs when a server is reachable (see live-server.ts) and
// creates / drops its own database.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const DB = "r17_json_root_pg";
const reachable = await pgReachable();

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-json-root.as");
});

describe("PostgresAdapter — view over a primitive @db.json field", () => {
  it("extracts the typed JSON root in the view DDL", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new PostgresAdapter(driver));
    await space.getView(fx.VjrItemView).dbAdapter.ensureTable();
    const ddl = driver.calls
      .filter((c) => c.method === "exec" && c.sql.includes("VIEW"))
      .map((c) => c.sql);
    expect(ddl).toHaveLength(1);
    expect(ddl[0]).toContain(
      `CASE jsonb_typeof(("vjr_items"."score")::jsonb #> '{}') WHEN 'number' THEN`,
    );
  });
});

describe.skipIf(!reachable)("[pg live] view over a primitive @db.json field", () => {
  let driver: PgDriver;
  let space: DbSpace;

  beforeAll(async () => {
    driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
    space = new DbSpace(() => new PostgresAdapter(driver));
    const result = await syncSchema(space, [fx.VjrItem, fx.VjrItemView]);
    expect(result.status).toBe("synced");
    await space.getTable(fx.VjrItem as never).insertMany(VJR_ITEMS);
  });

  afterAll(async () => {
    await driver?.close();
    await dropPgDatabase(DB);
  });

  defineViewJsonRootCases({ view: () => space.getView(fx.VjrItemView as never) });
});
