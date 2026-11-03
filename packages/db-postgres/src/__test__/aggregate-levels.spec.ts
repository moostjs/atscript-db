import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PAID, PER_CUSTOMER } from "../../../db/test-kit/aggregate-levels-cases";
import { PostgresAdapter } from "../postgres-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

// The SQL PostgreSQL receives for countDistinct over a field list, conditional
// aggregates (`$where`) and two-level aggregates (`$from`), since 0.1.168. The
// behaviour itself runs live in aggregate-levels.live.spec.ts.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/agg-levels.as");
});

async function sqlOf(controls: object, filter: object = {}) {
  const driver = createMockDriver({ allResult: [], getResult: { count: 0 } });
  const table = new AtscriptDbTable(fx.AlSale, new PostgresAdapter(driver));
  await table.aggregate({ filter, controls } as never);
  const call = driver.calls.find((c) => c.method === "all" || c.method === "get")!;
  return { sql: call.sql, params: call.params };
}

describe("PostgresAdapter aggregate levels — SQL", () => {
  it("renders a field list as COUNT(DISTINCT (a, b)) over rows whose every column is set", async () => {
    const { sql } = await sqlOf({
      $groupBy: ["region"],
      $select: ["region", { $fn: "countDistinct", $field: ["customerId", "productId"], $as: "p" }],
    });
    expect(sql).toBe(
      'SELECT "region", COUNT(DISTINCT CASE WHEN "customerId" IS NOT NULL AND "productId" IS NOT NULL THEN ("customerId", "productId") END) AS "p" FROM "al_sales" WHERE 1=1 GROUP BY "region"',
    );
  });

  it("renders conditions as boolean row-source columns read by FILTER (WHERE …), numbered in text order", async () => {
    const { sql, params } = await sqlOf(
      {
        $groupBy: ["region"],
        $select: [
          "region",
          { $fn: "sum", $field: "amount", $where: PAID, $as: "paidTotal" },
          { $fn: "count", $field: "*", $where: { qty: { $gt: 1 } }, $as: "multi" },
          { $fn: "countDistinct", $field: ["customerId", "productId"], $where: PAID, $as: "pairs" },
        ],
        $having: { paidTotal: { $gt: 10 } },
        $sort: { paidTotal: -1 },
        $limit: 3,
      },
      { region: { $ne: "X" } },
    );
    expect(sql).toBe(
      'SELECT "region", SUM("amount_cents") FILTER (WHERE "__as_w0") AS "paidTotal", COUNT(*) FILTER (WHERE "__as_w1") AS "multi", COUNT(DISTINCT CASE WHEN "customerId" IS NOT NULL AND "productId" IS NOT NULL THEN ("customerId", "productId") END) FILTER (WHERE "__as_w2") AS "pairs" ' +
        'FROM (SELECT "region", "amount_cents", "customerId", "productId", ("status" = $1) AS "__as_w0", ("qty" > $2) AS "__as_w1", ("status" = $3) AS "__as_w2" FROM "al_sales" WHERE "region" != $4) AS "__as_rows" ' +
        'GROUP BY "region" HAVING SUM("amount_cents") FILTER (WHERE "__as_w0") > $5 ORDER BY "paidTotal" DESC NULLS LAST LIMIT $6',
    );
    expect(params).toEqual(["paid", 1, "paid", "X", 10, 3]);
  });

  it("renders a two-level aggregate over the inner level as a derived table", async () => {
    const { sql, params } = await sqlOf(
      {
        $from: PER_CUSTOMER,
        $groupBy: ["region"],
        $select: [
          "region",
          { $fn: "avg", $field: "spent", $as: "avgSpent" },
          { $fn: "count", $field: "*", $where: { spent: { $gt: 10 } }, $as: "big" },
        ],
        $having: { avgSpent: { $gt: 1 } },
        $skip: 2,
      },
      { status: "paid" },
    );
    expect(sql).toBe(
      'SELECT "region", AVG("spent") AS "avgSpent", COUNT(*) FILTER (WHERE "__as_w0") AS "big" ' +
        'FROM (SELECT "region", "spent", ("spent" > $1) AS "__as_w0" FROM (SELECT "region", "customerId", SUM("amount_cents") AS "spent", COUNT(*) AS "orders", MAX("createdAt") AS "lastAt" FROM "al_sales" WHERE "status" = $2 GROUP BY "region", "customerId") AS "__as_inner" WHERE 1=1) AS "__as_rows" ' +
        'GROUP BY "region" HAVING AVG("spent") > $3 LIMIT ALL OFFSET $4',
    );
    expect(params).toEqual([10, "paid", 1, 2]);
  });

  it("counts the outer groups of a two-level aggregate", async () => {
    const { sql, params } = await sqlOf(
      { $from: PER_CUSTOMER, $groupBy: ["region"], $select: ["region"], $count: true },
      { status: "paid" },
    );
    expect(sql).toBe(
      'SELECT COUNT(*) AS "count" FROM (SELECT 1 FROM (SELECT "region", "customerId", SUM("amount_cents") AS "spent", COUNT(*) AS "orders", MAX("createdAt") AS "lastAt" FROM "al_sales" WHERE "status" = $1 GROUP BY "region", "customerId") AS "__as_inner" WHERE 1=1 GROUP BY "region") AS "_groups"',
    );
    expect(params).toEqual(["paid"]);
  });
});
