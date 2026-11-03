import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PAID, PER_CUSTOMER } from "../../../db/test-kit/aggregate-levels-cases";
import { MysqlAdapter } from "../mysql-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

// The SQL MySQL receives for countDistinct over a field list, conditional
// aggregates (`$where`) and two-level aggregates (`$from`), since 0.1.168. The
// behaviour itself runs live in aggregate-levels.live.spec.ts.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/agg-levels.as");
});

async function sqlOf(controls: object, filter: object = {}) {
  const driver = createMockDriver({ allResult: [], getResult: { count: 0 } });
  const table = new AtscriptDbTable(fx.AlSale, new MysqlAdapter(driver));
  await table.aggregate({ filter, controls } as never);
  const call = driver.calls.find((c) => c.method === "all" || c.method === "get")!;
  return { sql: call.sql, params: call.params };
}

describe("MysqlAdapter aggregate levels — SQL", () => {
  it("renders a field list as the native COUNT(DISTINCT a, b)", async () => {
    const { sql } = await sqlOf({
      $groupBy: ["region"],
      $select: ["region", { $fn: "countDistinct", $field: ["customerId", "productId"], $as: "p" }],
    });
    expect(sql).toBe(
      "SELECT `region`, COUNT(DISTINCT `customerId`, `productId`) AS `p` FROM `al_sales` WHERE 1=1 GROUP BY `region`",
    );
  });

  it("renders conditions as boolean row-source columns read through CASE WHEN, parameters in text order", async () => {
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
      "SELECT `region`, SUM(CASE WHEN `__as_w0` THEN `amount_cents` END) AS `paidTotal`, COUNT(CASE WHEN `__as_w1` THEN 1 END) AS `multi`, COUNT(DISTINCT CASE WHEN `__as_w2` THEN `customerId` END, CASE WHEN `__as_w2` THEN `productId` END) AS `pairs` FROM (SELECT `region`, `amount_cents`, `customerId`, `productId`, (`status` = ?) AS `__as_w0`, (`qty` > ?) AS `__as_w1`, (`status` = ?) AS `__as_w2` FROM `al_sales` WHERE `region` != ?) AS `__as_rows` GROUP BY `region` HAVING SUM(CASE WHEN `__as_w0` THEN `amount_cents` END) > ? ORDER BY `paidTotal` DESC LIMIT ?",
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
      "SELECT `region`, AVG(`spent`) AS `avgSpent`, COUNT(CASE WHEN `__as_w0` THEN 1 END) AS `big` FROM (SELECT `region`, `spent`, (`spent` > ?) AS `__as_w0` FROM (SELECT `region`, `customerId`, SUM(`amount_cents`) AS `spent`, COUNT(*) AS `orders`, MAX(`createdAt`) AS `lastAt` FROM `al_sales` WHERE `status` = ? GROUP BY `region`, `customerId`) AS `__as_inner` WHERE 1=1) AS `__as_rows` GROUP BY `region` HAVING AVG(`spent`) > ? LIMIT 18446744073709551615 OFFSET ?",
    );
    expect(params).toEqual([10, "paid", 1, 2]);
  });

  it("counts the outer groups of a two-level aggregate", async () => {
    const { sql, params } = await sqlOf(
      { $from: PER_CUSTOMER, $groupBy: ["region"], $select: ["region"], $count: true },
      { status: "paid" },
    );
    expect(sql).toBe(
      "SELECT COUNT(*) AS `count` FROM (SELECT 1 FROM (SELECT `region`, `customerId`, SUM(`amount_cents`) AS `spent`, COUNT(*) AS `orders`, MAX(`createdAt`) AS `lastAt` FROM `al_sales` WHERE `status` = ? GROUP BY `region`, `customerId`) AS `__as_inner` WHERE 1=1 GROUP BY `region`) AS `_groups`",
    );
    expect(params).toEqual(["paid"]);
  });
});
