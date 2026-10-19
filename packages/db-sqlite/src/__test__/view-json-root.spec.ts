import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";
import { VJR_ITEMS, defineViewJsonRootCases } from "../../../db/test-kit/view-json-root-cases";

// A view field over a whole primitive @db.json field reads the typed JSON root
// value — `9`, not the JSON text `'9'` — and sorts / filters by it (since
// 0.1.162; before, `'10'` sorted before `'9'`).

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-json-root.as");
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  const result = await new SchemaSync(space).run([fx.VjrItem, fx.VjrItemView], { force: true });
  expect(result.status).toBe("synced");
  await space.getTable(fx.VjrItem as never).insertMany(VJR_ITEMS);
});

afterAll(() => {
  driver?.close();
});

describe("SQLite views — primitive @db.json source field", () => {
  it("extracts the JSON root with a type guard in the view DDL", () => {
    const row = driver.get<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'vjr_item_view'`,
    );
    expect(row!.sql).toContain(
      `CASE json_type("vjr_items"."score", '$') WHEN 'integer' THEN json_extract("vjr_items"."score", '$') WHEN 'real' THEN json_extract("vjr_items"."score", '$') END AS "score"`,
    );
  });

  defineViewJsonRootCases({ view: () => space.getView(fx.VjrItemView as never) });
});
