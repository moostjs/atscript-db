import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

// ── Tests ────────────────────────────────────────────────────────────────────

let AggOrders: any;

describe("MysqlAdapter aggregate", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/agg-orders.as");
    AggOrders = fixtures.AggOrders;
  });

  it("groups by one dimension with SUM", async () => {
    const allResult = [
      { status: "active", total: 450 },
      { status: "cancelled", total: 125 },
    ];
    const driver = createMockDriver({ allResult });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(AggOrders, adapter);

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
    expect(call.sql).toContain("SUM(`amount`) AS `total`");
    expect(call.sql).toContain("GROUP BY `status`");
  });

  it("groups by two dimensions", async () => {
    const allResult = [
      { status: "active", currency: "USD", total: 300 },
      { status: "active", currency: "EUR", total: 150 },
    ];
    const driver = createMockDriver({ allResult });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(AggOrders, adapter);

    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status", "currency"],
        $select: ["status", "currency", { $fn: "sum", $field: "amount", $as: "total" }] as any,
      },
    });

    expect(result).toEqual(allResult);
    const call = driver.calls[0];
    expect(call.sql).toContain("GROUP BY `status`, `currency`");
  });

  it("supports multiple aggregate functions", async () => {
    const allResult = [
      { status: "active", total: 450, cnt: 3, avg_amount: 150, min_amount: 100, max_amount: 200 },
    ];
    const driver = createMockDriver({ allResult });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(AggOrders, adapter);

    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: [
          "status",
          { $fn: "sum", $field: "amount", $as: "total" },
          { $fn: "count", $field: "*", $as: "cnt" },
          { $fn: "avg", $field: "amount", $as: "avg_amount" },
          { $fn: "min", $field: "amount", $as: "min_amount" },
          { $fn: "max", $field: "amount", $as: "max_amount" },
        ] as any,
      },
    });

    expect(result).toEqual(allResult);
    const call = driver.calls[0];
    expect(call.sql).toContain("SUM(`amount`) AS `total`");
    expect(call.sql).toContain("COUNT(*) AS `cnt`");
    expect(call.sql).toContain("AVG(`amount`) AS `avg_amount`");
    expect(call.sql).toContain("MIN(`amount`) AS `min_amount`");
    expect(call.sql).toContain("MAX(`amount`) AS `max_amount`");
  });

  it("applies pre-aggregation filter", async () => {
    const allResult = [{ currency: "USD", total: 300 }];
    const driver = createMockDriver({ allResult });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(AggOrders, adapter);

    const result = await table.aggregate({
      filter: { status: "active" },
      controls: {
        $groupBy: ["currency"],
        $select: ["currency", { $fn: "sum", $field: "amount", $as: "total" }] as any,
      },
    });

    expect(result).toEqual(allResult);
    const call = driver.calls[0];
    expect(call.sql).toContain("WHERE");
    expect(call.params).toContain("active");
  });

  it("sorts by aggregate alias", async () => {
    const allResult = [
      { status: "active", total: 450 },
      { status: "cancelled", total: 125 },
    ];
    const driver = createMockDriver({ allResult });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(AggOrders, adapter);

    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "sum", $field: "amount", $as: "total" }] as any,
        $sort: { total: -1 } as any,
      },
    });

    expect(result).toEqual(allResult);
    const call = driver.calls[0];
    expect(call.sql).toContain("ORDER BY `total` DESC");
  });

  it("supports pagination with $limit and $skip", async () => {
    const allResult = [
      { status: "active", currency: "EUR", total: 150 },
      { status: "cancelled", currency: "USD", total: 50 },
    ];
    const driver = createMockDriver({ allResult });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(AggOrders, adapter);

    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status", "currency"],
        $select: ["status", "currency", { $fn: "sum", $field: "amount", $as: "total" }] as any,
        $sort: { total: -1 } as any,
        $limit: 2,
        $skip: 1,
      },
    });

    expect(result).toEqual(allResult);
    const call = driver.calls[0];
    expect(call.sql).toContain("LIMIT ?");
    expect(call.sql).toContain("OFFSET ?");
    expect(call.params).toContain(2);
    expect(call.params).toContain(1);
  });

  it("returns group count with $count", async () => {
    const driver = createMockDriver({ getResult: { count: 2 } });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(AggOrders, adapter);

    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $count: true,
      },
    });

    expect(result).toEqual([{ count: 2 }]);
    const call = driver.calls[0];
    expect(call.method).toBe("get");
    expect(call.sql).toContain("COUNT(*) AS `count`");
    expect(call.sql).toContain("GROUP BY `status`");
  });

  it("returns zero count when no rows match", async () => {
    const driver = createMockDriver({ getResult: null });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(AggOrders, adapter);

    const result = await table.aggregate({
      filter: { status: "nonexistent" },
      controls: {
        $groupBy: ["status"],
        $count: true,
      },
    });

    expect(result).toEqual([{ count: 0 }]);
  });

  it("count(*) vs count(field) in select", async () => {
    const allResult = [{ status: "active", total_rows: 3, with_amount: 3 }];
    const driver = createMockDriver({ allResult });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(AggOrders, adapter);

    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: [
          "status",
          { $fn: "count", $field: "*", $as: "total_rows" },
          { $fn: "count", $field: "amount", $as: "with_amount" },
        ] as any,
      },
    });

    expect(result).toEqual(allResult);
    const call = driver.calls[0];
    expect(call.sql).toContain("COUNT(*) AS `total_rows`");
    expect(call.sql).toContain("COUNT(`amount`) AS `with_amount`");
  });
});
