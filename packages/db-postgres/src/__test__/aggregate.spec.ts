import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

let AggOrders: any;
let AggPages: any;

describe("PostgresAdapter aggregate", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/agg-orders.as");
    AggOrders = fixtures.AggOrders;
    AggPages = fixtures.AggPages;
  });

  it("groups by one dimension with SUM", async () => {
    const allResult = [
      { status: "active", total: 450 },
      { status: "cancelled", total: 125 },
    ];
    const driver = createMockDriver({ allResult });
    const table = new AtscriptDbTable(AggOrders, new PostgresAdapter(driver));

    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "sum", $field: "amount", $as: "total" }] as any,
      },
    });

    expect(result).toEqual(allResult);
    const call = driver.calls[0];
    expect(call.method).toBe("all");
    expect(call.sql).toBe(
      'SELECT "status", SUM("amount") AS "total" FROM "orders" WHERE 1=1 GROUP BY "status"',
    );
    expect(call.params).toEqual([]);
  });

  // PostgreSQL rejects `HAVING "total" > $1` — a SELECT alias is not visible
  // in HAVING (`column "total" does not exist`). The builder renders the
  // aggregate expression instead, which every dialect accepts.
  it("$having on an aggregate alias renders the aggregate expression, not the alias", async () => {
    const driver = createMockDriver({ allResult: [{ status: "active", total: 450 }] });
    const table = new AtscriptDbTable(AggOrders, new PostgresAdapter(driver));

    await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "sum", $field: "amount", $as: "total" }] as any,
        $having: { total: { $gt: 100 } } as any,
      },
    });

    const call = driver.calls[0];
    expect(call.method).toBe("all");
    expect(call.sql).toBe(
      'SELECT "status", SUM("amount") AS "total" FROM "orders" WHERE 1=1 GROUP BY "status" HAVING SUM("amount") > $1',
    );
    expect(call.params).toEqual([100]);
  });

  it("$having mixes alias expressions and grouped columns with numbered placeholders", async () => {
    const driver = createMockDriver({ allResult: [] });
    const table = new AtscriptDbTable(AggOrders, new PostgresAdapter(driver));

    await table.aggregate({
      filter: { currency: "USD" },
      controls: {
        $groupBy: ["status"],
        $select: [
          "status",
          { $fn: "sum", $field: "amount", $as: "total" },
          { $fn: "count", $field: "*", $as: "cnt" },
        ] as any,
        $having: { total: { $gt: 100 }, $or: [{ status: "active" }, { cnt: { $gte: 2 } }] } as any,
        $sort: { total: -1 } as any,
        $limit: 5,
      },
    });

    expect(driver.calls[0].sql).toBe(
      'SELECT "status", SUM("amount") AS "total", COUNT(*) AS "cnt" FROM "orders" WHERE "currency" = $1 GROUP BY "status" HAVING SUM("amount") > $2 AND ("status" = $3 OR COUNT(*) >= $4) ORDER BY "total" DESC LIMIT $5',
    );
    expect(driver.calls[0].params).toEqual(["USD", 100, "active", 2, 5]);
  });

  it("$having on the implicit fn_field alias", async () => {
    const driver = createMockDriver({ allResult: [] });
    const table = new AtscriptDbTable(AggOrders, new PostgresAdapter(driver));

    await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "count", $field: "amount" }] as any,
        $having: { count_amount: { $gt: 1 } } as any,
      },
    });

    expect(driver.calls[0].sql).toBe(
      'SELECT "status", COUNT("amount") AS "count_amount" FROM "orders" WHERE 1=1 GROUP BY "status" HAVING COUNT("amount") > $1',
    );
    expect(driver.calls[0].params).toEqual([1]);
  });

  it("returns group count with $count", async () => {
    const driver = createMockDriver({ getResult: { count: "2" } });
    const table = new AtscriptDbTable(AggOrders, new PostgresAdapter(driver));

    const result = await table.aggregate({
      filter: {},
      controls: { $groupBy: ["status"], $count: true },
    });

    expect(result).toEqual([{ count: 2 }]);
    const call = driver.calls[0];
    expect(call.method).toBe("get");
    expect(call.sql).toBe(
      'SELECT COUNT(*) AS "count" FROM (SELECT 1 FROM "orders" WHERE 1=1 GROUP BY "status") AS "_groups"',
    );
  });

  // Aggregate rows have the regular-row shape (since 0.1.128): a grouped
  // flattened leaf (`stats__views`) comes back nested, not as a dotted key.
  it("grouped flattened-object keys come back nested; $having matches them by logical path", async () => {
    const driver = createMockDriver({ allResult: [{ stats__views: 10, cnt: 2 }] });
    const table = new AtscriptDbTable(AggPages, new PostgresAdapter(driver));

    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["stats.views"],
        $select: ["stats.views", { $fn: "count", $field: "*", $as: "cnt" }] as any,
        $having: { "stats.views": { $gte: 10 } } as any,
      },
    });

    expect(result).toEqual([{ stats: { views: 10 }, cnt: 2 }]);
    const call = driver.calls[0];
    expect(call.sql).toContain('GROUP BY "stats__views"');
    expect(call.sql).toContain('HAVING "stats__views" >= $1');
    expect(call.params).toEqual([10]);
  });

  it("$having on a real but non-grouped column is rejected in core before any SQL (since 0.1.128)", async () => {
    const driver = createMockDriver({ allResult: [] });
    const table = new AtscriptDbTable(AggOrders, new PostgresAdapter(driver));

    await expect(
      table.aggregate({
        filter: {},
        controls: {
          $groupBy: ["status"],
          $select: ["status", { $fn: "sum", $field: "amount", $as: "total" }] as any,
          $having: { amount: { $gt: 1 } } as any,
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_QUERY",
      errors: [
        {
          path: "amount",
          message: '$having key "amount" must be an aggregate alias or a $groupBy field',
        },
      ],
    });
    expect(driver.calls).toHaveLength(0);
  });
});
