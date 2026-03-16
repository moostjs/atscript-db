import { describe, it, expect } from "vite-plus/test";

import { buildAggregateSelect, buildAggregateCount } from "../agg";
import type { SqlDialect, TSqlFragment } from "../dialect";
import { UniquSelect } from "@atscript/db";

const mockDialect: SqlDialect = {
  quoteIdentifier: (name) => `[${name}]`,
  quoteTable: (name) => `[${name}]`,
  unlimitedLimit: "-1",
  toValue: (v) => {
    if (v === undefined) {
      return null;
    }
    if (v === null) {
      return null;
    }
    if (typeof v === "object") {
      return JSON.stringify(v);
    }
    if (typeof v === "boolean") {
      return v ? 1 : 0;
    }
    return v;
  },
  toParam: (v) => (typeof v === "boolean" ? (v ? 1 : 0) : v),
  regex: (col, v) => ({ sql: `${col} LIKE ?`, params: [String(v)] }),
  createViewPrefix: "CREATE VIEW",
};

const emptyWhere: TSqlFragment = { sql: "1=1", params: [] };

function makeSelect(
  items: Array<string | { $fn: string; $field: string; $as?: string }>,
): UniquSelect {
  return new UniquSelect(items as any);
}

describe("buildAggregateSelect", () => {
  it("builds a simple groupBy with one SUM", () => {
    const result = buildAggregateSelect(mockDialect, "orders", emptyWhere, {
      $groupBy: ["currency"],
      $select: makeSelect(["currency", { $fn: "sum", $field: "amount", $as: "total" }]),
    });
    expect(result.sql).toBe(
      "SELECT [currency], SUM([amount]) AS [total] FROM [orders] WHERE 1=1 GROUP BY [currency]",
    );
    expect(result.params).toEqual([]);
  });

  it("builds multiple aggregates (sum, count, avg, min, max)", () => {
    const result = buildAggregateSelect(mockDialect, "orders", emptyWhere, {
      $groupBy: ["status"],
      $select: makeSelect([
        "status",
        { $fn: "sum", $field: "amount", $as: "total" },
        { $fn: "count", $field: "*", $as: "cnt" },
        { $fn: "avg", $field: "amount", $as: "avg_amount" },
        { $fn: "min", $field: "amount", $as: "min_amount" },
        { $fn: "max", $field: "amount", $as: "max_amount" },
      ]),
    });
    expect(result.sql).toBe(
      "SELECT [status], SUM([amount]) AS [total], COUNT(*) AS [cnt], AVG([amount]) AS [avg_amount], MIN([amount]) AS [min_amount], MAX([amount]) AS [max_amount] FROM [orders] WHERE 1=1 GROUP BY [status]",
    );
  });

  it("handles count(*) vs count(field)", () => {
    const result = buildAggregateSelect(mockDialect, "orders", emptyWhere, {
      $groupBy: ["status"],
      $select: makeSelect([
        "status",
        { $fn: "count", $field: "*", $as: "total_count" },
        { $fn: "count", $field: "email", $as: "email_count" },
      ]),
    });
    expect(result.sql).toContain("COUNT(*) AS [total_count]");
    expect(result.sql).toContain("COUNT([email]) AS [email_count]");
  });

  it("includes WHERE filter, sort, limit, and skip", () => {
    const where: TSqlFragment = { sql: "[active] = ?", params: [1] };
    const result = buildAggregateSelect(mockDialect, "orders", where, {
      $groupBy: ["currency"],
      $select: makeSelect(["currency", { $fn: "sum", $field: "amount", $as: "total" }]),
      $sort: { total: -1 } as any,
      $limit: 10,
      $skip: 20,
    });
    expect(result.sql).toBe(
      "SELECT [currency], SUM([amount]) AS [total] FROM [orders] WHERE [active] = ? GROUP BY [currency] ORDER BY [total] DESC LIMIT ? OFFSET ?",
    );
    expect(result.params).toEqual([1, 10, 20]);
  });

  it("includes HAVING clause", () => {
    const result = buildAggregateSelect(mockDialect, "orders", emptyWhere, {
      $groupBy: ["currency"],
      $select: makeSelect(["currency", { $fn: "sum", $field: "amount", $as: "total" }]),
      $having: { total: { $gt: 100 } },
    });
    expect(result.sql).toBe(
      "SELECT [currency], SUM([amount]) AS [total] FROM [orders] WHERE 1=1 GROUP BY [currency] HAVING [total] > ?",
    );
    expect(result.params).toEqual([100]);
  });

  it("handles multiple groupBy fields", () => {
    const result = buildAggregateSelect(mockDialect, "orders", emptyWhere, {
      $groupBy: ["status", "currency"],
      $select: makeSelect(["status", "currency", { $fn: "count", $field: "*", $as: "cnt" }]),
    });
    expect(result.sql).toContain("GROUP BY [status], [currency]");
    expect(result.sql).toContain("[status], [currency], COUNT(*) AS [cnt]");
  });

  it("uses unlimitedLimit when skip is set but limit is not", () => {
    const result = buildAggregateSelect(mockDialect, "orders", emptyWhere, {
      $groupBy: ["status"],
      $select: makeSelect(["status", { $fn: "count", $field: "*", $as: "cnt" }]),
      $skip: 5,
    });
    expect(result.sql).toContain("LIMIT -1 OFFSET ?");
    expect(result.params).toEqual([5]);
  });

  it("generates auto-alias when $as is absent", () => {
    const result = buildAggregateSelect(mockDialect, "orders", emptyWhere, {
      $groupBy: ["status"],
      $select: makeSelect(["status", { $fn: "sum", $field: "amount" }]),
    });
    expect(result.sql).toContain("SUM([amount]) AS [sum_amount]");
  });
});

describe("buildAggregateCount", () => {
  it("builds a group count query", () => {
    const result = buildAggregateCount(mockDialect, "orders", emptyWhere, {
      $groupBy: ["currency"],
    });
    expect(result.sql).toBe(
      "SELECT COUNT(*) AS [count] FROM (SELECT 1 FROM [orders] WHERE 1=1 GROUP BY [currency]) AS [_groups]",
    );
    expect(result.params).toEqual([]);
  });

  it("passes through WHERE params", () => {
    const where: TSqlFragment = { sql: "[active] = ?", params: [1] };
    const result = buildAggregateCount(mockDialect, "orders", where, {
      $groupBy: ["currency"],
    });
    expect(result.sql).toContain("WHERE [active] = ?");
    expect(result.params).toEqual([1]);
  });

  it("handles multiple groupBy fields", () => {
    const result = buildAggregateCount(mockDialect, "orders", emptyWhere, {
      $groupBy: ["status", "currency"],
    });
    expect(result.sql).toContain("GROUP BY [status], [currency]");
  });

  it("returns simple count when $groupBy is empty", () => {
    const result = buildAggregateCount(mockDialect, "orders", emptyWhere, {});
    expect(result.sql).toBe("SELECT COUNT(*) AS [count] FROM [orders] WHERE 1=1");
    expect(result.params).toEqual([]);
  });
});
