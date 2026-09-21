import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

// ── Tests ────────────────────────────────────────────────────────────────────

let AggOrders: any;
let AggPages: any;

describe("MysqlAdapter aggregate", () => {
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

  it("$having on an aggregate alias renders the aggregate expression, not the alias", async () => {
    const driver = createMockDriver({ allResult: [{ status: "active", total: 450 }] });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(AggOrders, adapter);

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
      "SELECT `status`, SUM(`amount`) AS `total` FROM `orders` WHERE 1=1 GROUP BY `status` HAVING SUM(`amount`) > ?",
    );
    expect(call.params).toEqual([100]);
  });

  it("$having mixes alias expressions and grouped columns", async () => {
    const driver = createMockDriver({ allResult: [] });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(AggOrders, adapter);

    await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "count", $field: "*", $as: "cnt" }] as any,
        $having: { $or: [{ cnt: { $gte: 2 } }, { status: "active" }] } as any,
      },
    });

    expect(driver.calls[0].sql).toBe(
      "SELECT `status`, COUNT(*) AS `cnt` FROM `orders` WHERE 1=1 GROUP BY `status` HAVING (COUNT(*) >= ? OR `status` = ?)",
    );
    expect(driver.calls[0].params).toEqual([2, "active"]);
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

  // Aggregate rows have the regular-row shape (since 0.1.128): a grouped
  // flattened leaf (`stats__views`) comes back nested, not as a dotted key.
  it("grouped flattened-object keys come back nested; $having matches them by logical path", async () => {
    const driver = createMockDriver({ allResult: [{ stats__views: 10, cnt: 2 }] });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(AggPages, adapter);

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
    expect(call.sql).toContain("GROUP BY `stats__views`");
    expect(call.sql).toContain("HAVING `stats__views` >= ?");
    expect(call.params).toEqual([10]);
  });

  it("$having on a real but non-grouped column is rejected in core before any SQL (since 0.1.128)", async () => {
    const driver = createMockDriver({ allResult: [] });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(AggOrders, adapter);

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

// A grouped query that also carries `$search` used to drop the term on sources
// with native text search: the leaf list was filtered, the rollup and its
// `$count` were not — same request, two populations, no error. `$search`
// narrows the ROWS, so the predicate belongs in the WHERE, before GROUP BY.
describe("MysqlAdapter aggregate + $search", () => {
  let UsersTable: any;

  beforeAll(async () => {
    await prepareFixtures();
    UsersTable = (await import("./fixtures/test-table.as")).UsersTable;
  });

  const SEARCH_PRED = "MATCH(`bio`) AGAINST(? IN NATURAL LANGUAGE MODE)";

  it("puts the search predicate in the WHERE, before GROUP BY", async () => {
    const driver = createMockDriver({ allResult: [{ status: "active", cnt: 2 }] });
    const table = new AtscriptDbTable(UsersTable, new MysqlAdapter(driver));

    const result = await table.aggregate({
      filter: { status: "active" },
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "count", $field: "*", $as: "cnt" }],
        $search: "hello world",
      },
    } as any);

    expect(result).toEqual([{ status: "active", cnt: 2 }]);
    expect(driver.calls).toHaveLength(1);
    const call = driver.calls[0]!;
    expect(call.method).toBe("all");
    expect(call.sql).toBe(
      "SELECT `status`, COUNT(*) AS `cnt` FROM `auth`.`users` " +
        `WHERE \`status\` = ? AND ${SEARCH_PRED} GROUP BY \`status\``,
    );
    expect(call.params).toEqual(["active", "hello world"]);
  });

  // Relevance is a row property — after $group there is no per-row score to
  // sort on — and an injected cap would silently truncate group counts. Both
  // belong to the leaf search path only.
  it("adds no implicit relevance ORDER BY and no implicit LIMIT", async () => {
    const driver = createMockDriver({ allResult: [] });
    const table = new AtscriptDbTable(UsersTable, new MysqlAdapter(driver));

    await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "count", $field: "*", $as: "cnt" }],
        $search: "hello",
      },
    } as any);

    const sql = driver.calls[0]!.sql;
    expect(sql).toBe(
      "SELECT `status`, COUNT(*) AS `cnt` FROM `auth`.`users` " +
        `WHERE ${SEARCH_PRED} GROUP BY \`status\``,
    );
    expect(sql).not.toContain("ORDER BY");
    expect(sql).not.toContain("LIMIT");
    expect(sql).not.toContain("OFFSET");
    expect(driver.calls[0]!.params).toEqual(["hello"]);
  });

  it("$count counts only the groups the search left standing", async () => {
    const driver = createMockDriver({ getResult: { count: 3 } });
    const table = new AtscriptDbTable(UsersTable, new MysqlAdapter(driver));

    const result = await table.aggregate({
      filter: { status: "active" },
      controls: { $groupBy: ["status"], $search: "hello world", $count: true },
    } as any);

    expect(result).toEqual([{ count: 3 }]);
    const call = driver.calls[0]!;
    expect(call.method).toBe("get");
    expect(call.sql).toBe(
      "SELECT COUNT(*) AS `count` FROM (SELECT 1 FROM `auth`.`users` " +
        `WHERE \`status\` = ? AND ${SEARCH_PRED} GROUP BY \`status\`) AS \`_groups\``,
    );
    expect(call.params).toEqual(["active", "hello world"]);
  });

  // The search term is the last WHERE param, so it must land between the
  // filter params and the HAVING params — the ordering class of bug that
  // `$having` + `$count` hit before.
  it("$search and $having compose with params in WHERE-then-HAVING order", async () => {
    const driver = createMockDriver({ allResult: [] });
    const table = new AtscriptDbTable(UsersTable, new MysqlAdapter(driver));

    await table.aggregate({
      filter: { status: "active" },
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "count", $field: "*", $as: "cnt" }],
        $having: { cnt: { $gt: 2 } },
        $search: "hello",
        $sort: { status: 1 },
        $limit: 5,
        $skip: 2,
      },
    } as any);

    const call = driver.calls[0]!;
    expect(call.sql).toBe(
      "SELECT `status`, COUNT(*) AS `cnt` FROM `auth`.`users` " +
        `WHERE \`status\` = ? AND ${SEARCH_PRED} GROUP BY \`status\` ` +
        "HAVING COUNT(*) > ? ORDER BY `status` ASC LIMIT ? OFFSET ?",
    );
    expect(call.params).toEqual(["active", "hello", 2, 5, 2]);
  });

  it("$count + $having + $search keeps the search param ahead of the HAVING param", async () => {
    const driver = createMockDriver({ getResult: { count: 1 } });
    const table = new AtscriptDbTable(UsersTable, new MysqlAdapter(driver));

    await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "count", $field: "*", $as: "cnt" }],
        $having: { cnt: { $gt: 2 } },
        $search: "hello",
        $count: true,
      },
    } as any);

    const call = driver.calls[0]!;
    expect(call.sql).toBe(
      "SELECT COUNT(*) AS `count` FROM (SELECT 1 FROM `auth`.`users` " +
        `WHERE ${SEARCH_PRED} GROUP BY \`status\` HAVING COUNT(*) > ?) AS \`_groups\``,
    );
    expect(call.params).toEqual(["hello", 2]);
  });

  // Same resolution rules as the leaf `search()`: `$index` names the index by
  // its registry key, which is what `getSearchIndexes()` advertises.
  it("$index selects the named search index, exactly as search() resolves it", async () => {
    const driver = createMockDriver({ allResult: [] });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(UsersTable, adapter);
    expect(adapter.getSearchIndexes().map((i) => i.name)).toContain(
      "atscript__fulltext__search_idx",
    );

    await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $search: "hello",
        $index: "atscript__fulltext__search_idx",
      },
    } as any);

    expect(driver.calls[0]!.sql).toContain(SEARCH_PRED);

    await expect(
      table.aggregate({
        filter: {},
        controls: { $groupBy: ["status"], $search: "hello", $index: "nope_idx" },
      } as any),
    ).rejects.toThrow("No FULLTEXT index found for search");
  });

  it("no $search leaves the grouped SQL byte-identical, and a blank term is no term", async () => {
    const plain = createMockDriver({ allResult: [] });
    const plainTable = new AtscriptDbTable(UsersTable, new MysqlAdapter(plain));
    const controls = {
      $groupBy: ["status"],
      $select: ["status", { $fn: "count", $field: "*", $as: "cnt" }],
    };

    await plainTable.aggregate({ filter: { status: "active" }, controls } as any);
    expect(plain.calls[0]!.sql).toBe(
      "SELECT `status`, COUNT(*) AS `cnt` FROM `auth`.`users` WHERE `status` = ? GROUP BY `status`",
    );
    expect(plain.calls[0]!.params).toEqual(["active"]);

    // A blank-but-present term is still a search, and it matches nothing — core
    // short-circuits to an empty result, so no statement reaches the adapter.
    // (Leaf parity: `search()` returns [] outright for a whitespace-only term.)
    const blank = createMockDriver({ allResult: [] });
    const blankTable = new AtscriptDbTable(UsersTable, new MysqlAdapter(blank));
    const rows = await blankTable.aggregate({
      filter: { status: "active" },
      controls: { ...controls, $search: "   " },
    } as any);
    expect(rows).toEqual([]);
    expect(blank.calls).toHaveLength(0);
  });
});
