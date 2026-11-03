import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import {
  AL_ROWS,
  PAID,
  PER_CUSTOMER,
  defineAggregateLevelCases,
} from "../../../db/test-kit/aggregate-levels-cases";
import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

// countDistinct over a field list, conditional aggregates (`$where`) and
// two-level aggregates (`$from`) against a real in-memory SQLite (since
// 0.1.168): the shared case table, plus the SQL SQLite receives.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;
const statements: Array<{ sql: string; params: unknown[] }> = [];

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/agg-levels.as");
  driver = new BetterSqlite3Driver(":memory:");
  const all = driver.all.bind(driver);
  driver.all = ((sql: string, params?: unknown[]) => {
    statements.push({ sql, params: params ?? [] });
    return all(sql, params);
  }) as typeof driver.all;
  space = new DbSpace(() => new SqliteAdapter(driver));
  const result = await new SchemaSync(space).run([fx.AlSale], { force: true });
  expect(result.status).toBe("synced");
  await space.getTable(fx.AlSale).insertMany(AL_ROWS as never);
});

afterAll(() => {
  driver?.close();
});

const sales = () => space.getTable(fx.AlSale);

defineAggregateLevelCases("SQLite", sales);

describe("SQLite aggregate levels — SQL", () => {
  const last = async (controls: object, filter: object = {}) => {
    statements.length = 0;
    await sales().aggregate({ filter, controls } as never);
    return statements.at(-1)!;
  };

  it("renders a field list as COUNT(DISTINCT json_array(…)) guarded against NULL columns", async () => {
    const { sql } = await last({
      $groupBy: ["region"],
      $select: [{ $fn: "countDistinct", $field: ["customerId", "productId"], $as: "p" }],
    });
    expect(sql).toContain(
      'COUNT(DISTINCT CASE WHEN "customerId" IS NOT NULL AND "productId" IS NOT NULL THEN json_array("customerId", "productId") END) AS "p"',
    );
  });

  it("renders a condition as a boolean column of the row source and FILTER (WHERE …), parameters in text order", async () => {
    const { sql, params } = await last(
      {
        $groupBy: ["region"],
        $select: [{ $fn: "sum", $field: "amount", $where: PAID, $as: "t" }],
        $having: { t: { $gt: 1 } },
        $limit: 5,
      },
      { qty: { $lt: 100 } },
    );
    expect(sql).toBe(
      'SELECT SUM("amount_cents") FILTER (WHERE "__as_w0") AS "t" FROM (SELECT "region", "amount_cents", ("status" = ?) AS "__as_w0" FROM "al_sales" WHERE "qty" < ?) AS "__as_rows" GROUP BY "region" HAVING SUM("amount_cents") FILTER (WHERE "__as_w0") > ? LIMIT ?',
    );
    expect(params).toEqual(["paid", 100, 1, 5]);
  });

  it("renders the inner level of a two-level aggregate as a derived table", async () => {
    const { sql, params } = await last(
      {
        $from: PER_CUSTOMER,
        $groupBy: ["region"],
        $select: ["region", { $fn: "count", $field: "*", $as: "c" }],
        $having: { c: { $gt: 1 } },
      },
      { status: "paid" },
    );
    expect(sql).toBe(
      'SELECT "region", COUNT(*) AS "c" FROM (SELECT "region", "customerId", SUM("amount_cents") AS "spent", COUNT(*) AS "orders", MAX("createdAt") AS "lastAt" FROM "al_sales" WHERE "status" = ? GROUP BY "region", "customerId") AS "__as_inner" WHERE 1=1 GROUP BY "region" HAVING COUNT(*) > ?',
    );
    expect(params).toEqual(["paid", 1]);
  });
});
