import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

// View fields that reference a leaf inside a @db.json column (since 0.1.136),
// against a real in-memory SQLite: typed extraction with no coercion.

/**
 * JSON-leaf parity table — the same rows and expectations hold on every
 * adapter that renders JSON extraction. `data` is the raw JSON column
 * (inserted as-is, bypassing validation); `expected` is the view row's
 * `name` (string), `score` (number), `active` (boolean) and `tag`
 * (`nested.tag`, string): the declared primitive, or null when the path is
 * missing, the value is JSON null, or it has another JSON type.
 */
const JSON_LEAF_PARITY: Array<{
  id: number;
  case: string;
  data: unknown;
  expected: { name: unknown; score: unknown; active: unknown; tag: unknown };
}> = [
  {
    id: 1,
    case: "declared types",
    data: { name: "Ann", score: 10, active: true, nested: { tag: "red" } },
    expected: { name: "Ann", score: 10, active: true, tag: "red" },
  },
  {
    id: 2,
    case: "fractional number, false",
    data: { name: "Bob", score: 2.5, active: false, nested: { tag: "red" } },
    expected: { name: "Bob", score: 2.5, active: false, tag: "red" },
  },
  {
    id: 3,
    case: "JSON null",
    data: { name: null, score: null, active: null, nested: { tag: null } },
    expected: { name: null, score: null, active: null, tag: null },
  },
  {
    id: 4,
    case: "missing keys",
    data: {},
    expected: { name: null, score: null, active: null, tag: null },
  },
  {
    id: 5,
    case: "other scalar types (no coercion)",
    data: { name: 5, score: "5", active: "true", nested: { tag: true } },
    expected: { name: null, score: null, active: null, tag: null },
  },
  {
    id: 6,
    case: "containers and 0/1 instead of booleans",
    data: { name: ["Ann"], score: { v: 1 }, active: 1, nested: "blue" },
    expected: { name: null, score: null, active: null, tag: null },
  },
  {
    id: 7,
    case: "SQL NULL column",
    data: null,
    expected: { name: null, score: null, active: null, tag: null },
  },
  {
    id: 8,
    case: "empty string, zero",
    data: { name: "", score: 0, active: false, nested: { tag: "skip" } },
    expected: { name: "", score: 0, active: false, tag: "skip" },
  },
];

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-json.as");
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  const result = await new SchemaSync(space).run([fx.VjItem, fx.VjItemView, fx.VjTagTotals], {
    force: true,
  });
  expect(result.status).toBe("synced");

  // Raw inserts: the wrong-typed rows would not pass table validation.
  for (const row of JSON_LEAF_PARITY) {
    driver.run(`INSERT INTO "vj_items" ("id", "label", "data") VALUES (?, ?, ?)`, [
      row.id,
      row.case,
      row.data === null ? null : JSON.stringify(row.data),
    ]);
  }
});

afterAll(() => {
  driver?.close();
});

function view(type: unknown) {
  return space.getView(type as never) as any;
}

describe("SQLite views — JSON leaf extraction", () => {
  it("renders a typed, parameter-free extraction in the view DDL", () => {
    const row = driver.get<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'vj_item_view'`,
    );
    expect(row!.sql).toContain(
      `CASE json_type("vj_items"."data", '$."nested"."tag"') WHEN 'text' THEN json_extract("vj_items"."data", '$."nested"."tag"') END AS "tag"`,
    );
  });

  it.each(JSON_LEAF_PARITY)("parity: $case", async (row) => {
    const found = await view(fx.VjItemView).findOne({ filter: { id: row.id }, controls: {} });
    expect(found).toEqual({ id: row.id, label: row.case, ...row.expected });
  });

  it("filters and sorts on extracted columns", async () => {
    const found = await view(fx.VjItemView).findMany({
      filter: { score: { $gte: 0 }, active: false },
      controls: { $sort: { score: -1 }, $select: ["id", "score"] },
    });
    expect(found).toEqual([
      { id: 2, score: 2.5 },
      { id: 8, score: 0 },
    ]);

    const byName = await view(fx.VjItemView).findMany({
      filter: { name: { $exists: true } },
      controls: { $sort: { name: 1 }, $select: ["id"] },
    });
    expect(byName).toEqual([{ id: 8 }, { id: 1 }, { id: 2 }]);
  });

  it("groups a query on an extracted column", async () => {
    const result = await view(fx.VjItemView).aggregate({
      filter: {},
      controls: {
        $groupBy: ["tag"],
        $select: ["tag", { $fn: "count", $field: "*", $as: "n" }],
        $sort: { tag: 1 },
      },
    });
    expect(result).toEqual([
      { tag: null, n: 5 },
      { tag: "red", n: 2 },
      { tag: "skip", n: 1 },
    ]);
  });

  it("uses JSON leaves as view dimension, aggregate source and HAVING operand", async () => {
    const found = await view(fx.VjTagTotals).findMany({
      filter: {},
      controls: { $sort: { tag: 1 } },
    });
    // null tag: no numeric score → SUM is null → HAVING drops it; "skip" by HAVING
    expect(found).toEqual([{ tag: "red", total: 12.5, items: 2 }]);
  });
});
