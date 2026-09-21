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

// A grouped query that also carries `$search` used to drop the term on sources
// with native text search: the leaf list was filtered, the rollup and its
// `$count` were not — same request, two populations, no error. `$search`
// narrows the ROWS, so the predicate belongs in the WHERE, before GROUP BY.
describe("PostgresAdapter aggregate + $search", () => {
  let UsersTable: any;

  beforeAll(async () => {
    await prepareFixtures();
    UsersTable = (await import("./fixtures/test-table.as")).UsersTable;
  });

  const SEARCH_PRED = `to_tsvector('english', coalesce("bio", '')) @@ plainto_tsquery('english', $2)`;

  it("puts the search predicate in the WHERE, before GROUP BY", async () => {
    const driver = createMockDriver({ allResult: [{ status: "active", cnt: 2 }] });
    const table = new AtscriptDbTable(UsersTable, new PostgresAdapter(driver));

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
      `SELECT "status", COUNT(*) AS "cnt" FROM "auth"."users" WHERE "status" = $1 AND ${SEARCH_PRED} GROUP BY "status"`,
    );
    expect(call.params).toEqual(["active", "hello world"]);
  });

  // Relevance is a row property — after $group there is no per-row score to
  // sort on — and an injected cap would silently truncate group counts. Both
  // belong to the leaf search path only.
  it("adds no implicit relevance ORDER BY and no implicit LIMIT", async () => {
    const driver = createMockDriver({ allResult: [] });
    const table = new AtscriptDbTable(UsersTable, new PostgresAdapter(driver));

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
      `SELECT "status", COUNT(*) AS "cnt" FROM "auth"."users" WHERE to_tsvector('english', coalesce("bio", '')) @@ plainto_tsquery('english', $1) GROUP BY "status"`,
    );
    expect(sql).not.toContain("ORDER BY");
    expect(sql).not.toContain("LIMIT");
    expect(sql).not.toContain("OFFSET");
    expect(sql).not.toContain("ts_rank");
    expect(driver.calls[0]!.params).toEqual(["hello"]);
  });

  it("$count counts only the groups the search left standing", async () => {
    const driver = createMockDriver({ getResult: { count: "3" } });
    const table = new AtscriptDbTable(UsersTable, new PostgresAdapter(driver));

    const result = await table.aggregate({
      filter: { status: "active" },
      controls: { $groupBy: ["status"], $search: "hello world", $count: true },
    } as any);

    expect(result).toEqual([{ count: 3 }]);
    const call = driver.calls[0]!;
    expect(call.method).toBe("get");
    expect(call.sql).toBe(
      `SELECT COUNT(*) AS "count" FROM (SELECT 1 FROM "auth"."users" WHERE "status" = $1 AND ${SEARCH_PRED} GROUP BY "status") AS "_groups"`,
    );
    expect(call.params).toEqual(["active", "hello world"]);
  });

  // The search term is the last WHERE param, so it must land between the
  // filter params and the HAVING params — the ordering class of bug that
  // `$having` + `$count` hit before.
  it("$search and $having compose with params in WHERE-then-HAVING order", async () => {
    const driver = createMockDriver({ allResult: [] });
    const table = new AtscriptDbTable(UsersTable, new PostgresAdapter(driver));

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
      `SELECT "status", COUNT(*) AS "cnt" FROM "auth"."users" WHERE "status" = $1 AND ${SEARCH_PRED} GROUP BY "status" HAVING COUNT(*) > $3 ORDER BY "status" ASC LIMIT $4 OFFSET $5`,
    );
    expect(call.params).toEqual(["active", "hello", 2, 5, 2]);
  });

  it("$count + $having + $search keeps the search param ahead of the HAVING param", async () => {
    const driver = createMockDriver({ getResult: { count: "1" } });
    const table = new AtscriptDbTable(UsersTable, new PostgresAdapter(driver));

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
      `SELECT COUNT(*) AS "count" FROM (SELECT 1 FROM "auth"."users" WHERE to_tsvector('english', coalesce("bio", '')) @@ plainto_tsquery('english', $1) GROUP BY "status" HAVING COUNT(*) > $2) AS "_groups"`,
    );
    expect(call.params).toEqual(["hello", 2]);
  });

  // Same resolution rules as the leaf `search()`: `$index` names the index by
  // its registry key, which is what `getSearchIndexes()` advertises.
  it("$index selects the named search index, exactly as search() resolves it", async () => {
    const driver = createMockDriver({ allResult: [] });
    const adapter = new PostgresAdapter(driver);
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

    expect(driver.calls[0]!.sql).toContain(
      `to_tsvector('english', coalesce("bio", '')) @@ plainto_tsquery('english', $1)`,
    );

    await expect(
      table.aggregate({
        filter: {},
        controls: { $groupBy: ["status"], $search: "hello", $index: "nope_idx" },
      } as any),
    ).rejects.toThrow("No fulltext index found for search");
  });

  it("no $search leaves the grouped SQL byte-identical, and a blank term is no term", async () => {
    const plain = createMockDriver({ allResult: [] });
    const plainTable = new AtscriptDbTable(UsersTable, new PostgresAdapter(plain));
    const controls = {
      $groupBy: ["status"],
      $select: ["status", { $fn: "count", $field: "*", $as: "cnt" }],
    };

    await plainTable.aggregate({ filter: { status: "active" }, controls } as any);
    expect(plain.calls[0]!.sql).toBe(
      `SELECT "status", COUNT(*) AS "cnt" FROM "auth"."users" WHERE "status" = $1 GROUP BY "status"`,
    );
    expect(plain.calls[0]!.params).toEqual(["active"]);

    // A blank-but-present term is still a search, and it matches nothing — core
    // short-circuits to an empty result, so no statement reaches the adapter.
    // (Leaf parity: `search()` returns [] outright for a whitespace-only term.)
    const blank = createMockDriver({ allResult: [] });
    const blankTable = new AtscriptDbTable(UsersTable, new PostgresAdapter(blank));
    const rows = await blankTable.aggregate({
      filter: { status: "active" },
      controls: { ...controls, $search: "   " },
    } as any);
    expect(rows).toEqual([]);
    expect(blank.calls).toHaveLength(0);
  });
});
