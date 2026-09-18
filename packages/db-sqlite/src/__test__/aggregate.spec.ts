import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

let AggOrders: any;
let AggPages: any;

describe("SqliteAdapter aggregate", () => {
  let driver: BetterSqlite3Driver;
  let adapter: SqliteAdapter;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/agg-orders.as");
    AggOrders = fixtures.AggOrders;
    AggPages = fixtures.AggPages;
  });

  beforeEach(async () => {
    driver = new BetterSqlite3Driver(":memory:");
    adapter = new SqliteAdapter(driver);
    table = new AtscriptDbTable(AggOrders, adapter);
    await table.ensureTable();

    // Seed test data
    await table.insertOne({ id: 1, status: "active", currency: "USD", amount: 100, quantity: 2 });
    await table.insertOne({ id: 2, status: "active", currency: "USD", amount: 200, quantity: 3 });
    await table.insertOne({ id: 3, status: "active", currency: "EUR", amount: 150, quantity: 1 });
    await table.insertOne({ id: 4, status: "cancelled", currency: "USD", amount: 50, quantity: 1 });
    await table.insertOne({ id: 5, status: "cancelled", currency: "EUR", amount: 75, quantity: 2 });
  });

  afterEach(() => {
    driver.close();
  });

  it("groups by one dimension with SUM", async () => {
    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "sum", $field: "amount", $as: "total" }] as any,
      },
    });

    expect(result).toHaveLength(2);
    const active = result.find((r) => r.status === "active");
    const cancelled = result.find((r) => r.status === "cancelled");
    expect(active?.total).toBe(450);
    expect(cancelled?.total).toBe(125);
  });

  it("groups by two dimensions", async () => {
    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status", "currency"],
        $select: ["status", "currency", { $fn: "sum", $field: "amount", $as: "total" }] as any,
      },
    });

    expect(result).toHaveLength(4);
    const activeUsd = result.find((r) => r.status === "active" && r.currency === "USD");
    expect(activeUsd?.total).toBe(300);
  });

  it("supports multiple aggregate functions", async () => {
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

    const active = result.find((r) => r.status === "active")!;
    expect(active.total).toBe(450);
    expect(active.cnt).toBe(3);
    expect(active.avg_amount).toBe(150);
    expect(active.min_amount).toBe(100);
    expect(active.max_amount).toBe(200);
  });

  it("applies pre-aggregation filter", async () => {
    const result = await table.aggregate({
      filter: { status: "active" },
      controls: {
        $groupBy: ["currency"],
        $select: ["currency", { $fn: "sum", $field: "amount", $as: "total" }] as any,
      },
    });

    expect(result).toHaveLength(2);
    const usd = result.find((r) => r.currency === "USD");
    expect(usd?.total).toBe(300); // only active USD: 100 + 200
  });

  it("sorts by aggregate alias", async () => {
    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "sum", $field: "amount", $as: "total" }] as any,
        $sort: { total: -1 } as any,
      },
    });

    expect(result[0].status).toBe("active");
    expect(result[0].total).toBe(450);
    expect(result[1].status).toBe("cancelled");
    expect(result[1].total).toBe(125);
  });

  it("$having on an aggregate alias executes (expression form, same SQL as PostgreSQL)", async () => {
    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["currency"],
        $select: [
          "currency",
          { $fn: "sum", $field: "amount", $as: "total" },
          { $fn: "count", $field: "*", $as: "cnt" },
        ] as any,
        $having: { total: { $gt: 300 }, $or: [{ currency: "USD" }, { cnt: { $gte: 5 } }] } as any,
      },
    });

    // USD: 100 + 200 + 50 = 350 (> 300, currency matches); EUR: 225 (filtered out)
    expect(result).toEqual([{ currency: "USD", total: 350, cnt: 3 }]);
  });

  it("supports pagination with $limit and $skip", async () => {
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

    expect(result).toHaveLength(2);
  });

  it("returns group count with $count", async () => {
    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $count: true,
      },
    });

    expect(result).toEqual([{ count: 2 }]);
  });

  it("returns group count with filter", async () => {
    const result = await table.aggregate({
      filter: { currency: "USD" },
      controls: {
        $groupBy: ["status"],
        $count: true,
      },
    });

    expect(result).toEqual([{ count: 2 }]); // active+cancelled both have USD
  });

  it("$count with $having counts the groups that survive HAVING (since 0.1.129)", async () => {
    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["currency"],
        $select: ["currency", { $fn: "sum", $field: "amount", $as: "total" }] as any,
        $having: { total: { $gt: 300 } } as any,
        $count: true,
      },
    });

    // USD: 350 passes; EUR: 225 does not
    expect(result).toEqual([{ count: 1 }]);
  });

  it("$count with $having and no $groupBy treats the table as one group (0 or 1)", async () => {
    const count = (gt: number) =>
      table.aggregate({
        filter: {},
        controls: {
          $groupBy: [] as any,
          $select: [{ $fn: "sum", $field: "amount", $as: "total" }] as any,
          $having: { total: { $gt: gt } } as any,
          $count: true,
        },
      });

    // Whole table: 575. SQLite rejects `SELECT 1 … HAVING` without GROUP BY,
    // so the inner select is itself an aggregate.
    expect(await count(500)).toEqual([{ count: 1 }]);
    expect(await count(1000)).toEqual([{ count: 0 }]);
  });

  it("count(*) vs count(field) produce correct results", async () => {
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

    const active = result.find((r) => r.status === "active")!;
    expect(active.total_rows).toBe(3);
    expect(active.with_amount).toBe(3); // all active rows have amount
  });

  // Aggregate rows have the regular-row shape (since 0.1.128): a grouped
  // flattened leaf (`stats__views`) comes back nested, not as a dotted key.
  it("grouped flattened-object keys come back nested; $having matches them by logical path", async () => {
    const pages = new AtscriptDbTable(AggPages, adapter);
    await pages.ensureTable();
    await pages.insertMany([
      { id: 1, title: "a", stats: { views: 10 } },
      { id: 2, title: "b", stats: { views: 10 } },
      { id: 3, title: "c", stats: { views: 20 } },
    ]);
    const cnt = { $fn: "count", $field: "*", $as: "cnt" };

    const result = await pages.aggregate({
      filter: {},
      controls: {
        $groupBy: ["stats.views"],
        $select: ["stats.views", cnt] as any,
        $sort: { "stats.views": 1 } as any,
      },
    });
    expect(result).toEqual([
      { stats: { views: 10 }, cnt: 2 },
      { stats: { views: 20 }, cnt: 1 },
    ]);

    const having = await pages.aggregate({
      filter: {},
      controls: {
        $groupBy: ["stats.views"],
        $select: ["stats.views", cnt] as any,
        $having: { "stats.views": { $gte: 20 } } as any,
      },
    });
    expect(having).toEqual([{ stats: { views: 20 }, cnt: 1 }]);
  });

  // Aggregate rows go through the same reverse mapping as regular rows (since
  // 0.1.128): a grouped boolean column is coerced from the stored 0 / 1.
  it("a grouped boolean column comes back as true / false", async () => {
    const pages = new AtscriptDbTable(AggPages, adapter);
    await pages.ensureTable();
    await pages.insertMany([
      { id: 1, title: "a", stats: { views: 1 }, published: true },
      { id: 2, title: "b", stats: { views: 1 }, published: false },
      { id: 3, title: "c", stats: { views: 1 }, published: true },
    ]);

    const result = await pages.aggregate({
      filter: {},
      controls: {
        $groupBy: ["published"],
        $select: ["published", { $fn: "count", $field: "*", $as: "cnt" }] as any,
        $sort: { published: 1 } as any,
      },
    });
    expect(result).toEqual([
      { published: false, cnt: 1 },
      { published: true, cnt: 2 },
    ]);
  });

  it("$having on a real but non-grouped column is rejected in core before any SQL (since 0.1.128)", async () => {
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
  });
});
