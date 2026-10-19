import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

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
  await space
    .getTable(fx.VjrItem as never)
    .insertMany([
      { id: 1, score: 9, label: "b", active: true },
      { id: 2, score: 10, label: "a", active: false },
      { id: 3, score: 2.5, label: "c", active: true },
      { id: 4 },
    ] as never);
});

afterAll(() => {
  driver?.close();
});

const ids = async (query: Record<string, unknown>) =>
  (
    (await (space.getView(fx.VjrItemView as never) as any).findMany({
      filter: {},
      ...query,
      controls: { $select: ["id"], ...(query.controls as object) },
    })) as Array<{ id: number }>
  ).map((r) => r.id);

describe("SQLite views — primitive @db.json source field", () => {
  it("extracts the JSON root with a type guard in the view DDL", () => {
    const row = driver.get<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'vjr_item_view'`,
    );
    expect(row!.sql).toContain(
      `CASE json_type("vjr_items"."score", '$') WHEN 'integer' THEN json_extract("vjr_items"."score", '$') WHEN 'real' THEN json_extract("vjr_items"."score", '$') END AS "score"`,
    );
  });

  it("returns the typed values", async () => {
    const rows = await (space.getView(fx.VjrItemView as never) as any).findMany({
      filter: {},
      controls: { $sort: { id: 1 } },
    });
    expect(rows).toEqual([
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
