/* eslint-disable unicorn/consistent-function-scoping */
import { describe, it, expect } from "vite-plus/test";

import {
  buildInsert,
  buildSelect,
  buildUpdate,
  buildDelete,
  buildProjection,
  buildCreateView,
} from "../sql-builder";
import type { SqlDialect, TSqlFragment } from "../dialect";
import type {
  UniquSelect,
  TViewPlan,
  TViewColumnMapping,
  AtscriptQueryFieldRef,
} from "@atscript/db";
const stubType = (() => null) as unknown as TViewPlan["entryType"];

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

describe("buildInsert", () => {
  it("builds a basic INSERT statement", () => {
    const result = buildInsert(mockDialect, "users", { name: "Alice", age: 30 });
    expect(result.sql).toBe("INSERT INTO [users] ([name], [age]) VALUES (?, ?)");
    expect(result.params).toEqual(["Alice", 30]);
  });

  it("converts values via dialect.toValue", () => {
    const result = buildInsert(mockDialect, "items", {
      active: true,
      tags: ["a", "b"],
      note: null,
    });
    expect(result.params).toEqual([1, '["a","b"]', null]);
  });
});

describe("buildSelect", () => {
  const emptyWhere: TSqlFragment = { sql: "1=1", params: [] };

  it("builds a basic SELECT", () => {
    const result = buildSelect(mockDialect, "users", emptyWhere);
    expect(result.sql).toBe("SELECT * FROM [users] WHERE 1=1");
    expect(result.params).toEqual([]);
  });

  it("includes sort", () => {
    const result = buildSelect(mockDialect, "users", emptyWhere, {
      $sort: { name: 1, age: -1 },
    });
    expect(result.sql).toBe("SELECT * FROM [users] WHERE 1=1 ORDER BY [name] ASC, [age] DESC");
  });

  it("includes limit", () => {
    const result = buildSelect(mockDialect, "users", emptyWhere, { $limit: 10 });
    expect(result.sql).toBe("SELECT * FROM [users] WHERE 1=1 LIMIT ?");
    expect(result.params).toEqual([10]);
  });

  it("includes skip with limit", () => {
    const result = buildSelect(mockDialect, "users", emptyWhere, { $limit: 10, $skip: 20 });
    expect(result.sql).toBe("SELECT * FROM [users] WHERE 1=1 LIMIT ? OFFSET ?");
    expect(result.params).toEqual([10, 20]);
  });

  it("uses unlimitedLimit when skip is set but limit is not", () => {
    const result = buildSelect(mockDialect, "users", emptyWhere, { $skip: 5 });
    expect(result.sql).toBe("SELECT * FROM [users] WHERE 1=1 LIMIT -1 OFFSET ?");
    expect(result.params).toEqual([5]);
  });

  it("applies projection from $select", () => {
    const select = { asArray: ["name", "age"] } as UniquSelect;
    const result = buildSelect(mockDialect, "users", emptyWhere, { $select: select });
    expect(result.sql).toBe("SELECT [name], [age] FROM [users] WHERE 1=1");
  });

  it("combines where params with control params", () => {
    const where: TSqlFragment = { sql: "[active] = ?", params: [1] };
    const result = buildSelect(mockDialect, "users", where, { $limit: 5 });
    expect(result.sql).toBe("SELECT * FROM [users] WHERE [active] = ? LIMIT ?");
    expect(result.params).toEqual([1, 5]);
  });
});

describe("buildUpdate", () => {
  const where: TSqlFragment = { sql: "[id] = ?", params: [1] };

  it("builds a basic UPDATE", () => {
    const result = buildUpdate(mockDialect, "users", { name: "Bob" }, where);
    expect(result.sql).toBe("UPDATE [users] SET [name] = ? WHERE [id] = ?");
    expect(result.params).toEqual(["Bob", 1]);
  });

  it("includes LIMIT when specified", () => {
    const result = buildUpdate(mockDialect, "users", { name: "Bob" }, where, 1);
    expect(result.sql).toBe("UPDATE [users] SET [name] = ? WHERE [id] = ? LIMIT 1");
  });

  it("converts values via dialect.toValue", () => {
    const result = buildUpdate(mockDialect, "items", { active: false, meta: { x: 1 } }, where);
    expect(result.params).toEqual([0, '{"x":1}', 1]);
  });
});

describe("buildDelete", () => {
  const where: TSqlFragment = { sql: "[id] = ?", params: [42] };

  it("builds a basic DELETE", () => {
    const result = buildDelete(mockDialect, "users", where);
    expect(result.sql).toBe("DELETE FROM [users] WHERE [id] = ?");
    expect(result.params).toEqual([42]);
  });

  it("includes LIMIT when specified", () => {
    const result = buildDelete(mockDialect, "users", where, 1);
    expect(result.sql).toBe("DELETE FROM [users] WHERE [id] = ? LIMIT 1");
  });
});

describe("buildProjection", () => {
  it("returns * when select is undefined", () => {
    expect(buildProjection(mockDialect)).toBe("*");
  });

  it("returns * when select has no asArray", () => {
    expect(buildProjection(mockDialect, {} as UniquSelect)).toBe("*");
  });

  it("returns * for empty asArray", () => {
    expect(buildProjection(mockDialect, { asArray: [] } as unknown as UniquSelect)).toBe("*");
  });

  it("quotes and joins field names", () => {
    const select = { asArray: ["id", "name", "email"] } as UniquSelect;
    expect(buildProjection(mockDialect, select)).toBe("[id], [name], [email]");
  });
});

describe("buildCreateView", () => {
  const resolveFieldRef = (ref: AtscriptQueryFieldRef) => `[${(ref as any).table}].[${ref.field}]`;

  it("builds a basic CREATE VIEW", () => {
    const plan: TViewPlan = {
      entryType: stubType,
      entryTable: "users",
      joins: [],
      materialized: false,
    };
    const columns: TViewColumnMapping[] = [
      { viewColumn: "user_id", sourceTable: "users", sourceColumn: "id" },
      { viewColumn: "user_name", sourceTable: "users", sourceColumn: "name" },
    ];

    const result = buildCreateView(mockDialect, "user_view", plan, columns, resolveFieldRef);
    expect(result).toBe(
      "CREATE VIEW [user_view] AS SELECT [users].[id] AS [user_id], [users].[name] AS [user_name] FROM [users]",
    );
  });

  it("includes JOIN clauses", () => {
    const plan: TViewPlan = {
      entryType: stubType,
      entryTable: "orders",
      joins: [
        {
          targetType: stubType,
          targetTable: "users",
          condition: {
            left: { table: "orders", field: "user_id" } as any as AtscriptQueryFieldRef,
            op: "$eq",
            right: { table: "users", field: "id" } as any as AtscriptQueryFieldRef,
          },
        },
      ],
      materialized: false,
    };
    const columns: TViewColumnMapping[] = [
      { viewColumn: "order_id", sourceTable: "orders", sourceColumn: "id" },
      { viewColumn: "user_name", sourceTable: "users", sourceColumn: "name" },
    ];

    const result = buildCreateView(mockDialect, "order_view", plan, columns, resolveFieldRef);
    expect(result).toContain("JOIN [users] ON [orders].[user_id] = [users].[id]");
  });

  it("includes WHERE filter", () => {
    const plan: TViewPlan = {
      entryType: stubType,
      entryTable: "users",
      joins: [],
      filter: {
        left: { table: "users", field: "active" } as any as AtscriptQueryFieldRef,
        op: "$eq",
        right: 1,
      },
      materialized: false,
    };
    const columns: TViewColumnMapping[] = [
      { viewColumn: "id", sourceTable: "users", sourceColumn: "id" },
    ];

    const result = buildCreateView(mockDialect, "active_users", plan, columns, resolveFieldRef);
    expect(result).toContain("WHERE [users].[active] = 1");
  });

  it("uses dialect createViewPrefix", () => {
    const customDialect = { ...mockDialect, createViewPrefix: "CREATE OR REPLACE VIEW" };
    const plan: TViewPlan = {
      entryType: stubType,
      entryTable: "users",
      joins: [],
      materialized: false,
    };
    const columns: TViewColumnMapping[] = [
      { viewColumn: "id", sourceTable: "users", sourceColumn: "id" },
    ];

    const result = buildCreateView(customDialect, "v", plan, columns, resolveFieldRef);
    expect(result.startsWith("CREATE OR REPLACE VIEW")).toBe(true);
  });

  it("wraps aggregate columns with SQL functions", () => {
    const plan: TViewPlan = {
      entryType: stubType,
      entryTable: "orders",
      joins: [],
      materialized: false,
    };
    const columns: TViewColumnMapping[] = [
      { viewColumn: "category", sourceTable: "orders", sourceColumn: "category" },
      {
        viewColumn: "totalRevenue",
        sourceTable: "orders",
        sourceColumn: "amount",
        aggFn: "sum",
        aggField: "amount",
      },
      {
        viewColumn: "orderCount",
        sourceTable: "orders",
        sourceColumn: "*",
        aggFn: "count",
        aggField: "*",
      },
      {
        viewColumn: "avgAmount",
        sourceTable: "orders",
        sourceColumn: "amount",
        aggFn: "avg",
        aggField: "amount",
      },
    ];

    const result = buildCreateView(mockDialect, "order_stats", plan, columns, resolveFieldRef);
    expect(result).toContain("SUM([orders].[amount]) AS [totalRevenue]");
    expect(result).toContain("COUNT(*) AS [orderCount]");
    expect(result).toContain("AVG([orders].[amount]) AS [avgAmount]");
    expect(result).toContain("[orders].[category] AS [category]");
  });

  it("generates GROUP BY for dimension columns when aggregates present", () => {
    const plan: TViewPlan = {
      entryType: stubType,
      entryTable: "orders",
      joins: [],
      materialized: false,
    };
    const columns: TViewColumnMapping[] = [
      { viewColumn: "category", sourceTable: "orders", sourceColumn: "category" },
      { viewColumn: "region", sourceTable: "orders", sourceColumn: "region" },
      {
        viewColumn: "total",
        sourceTable: "orders",
        sourceColumn: "amount",
        aggFn: "sum",
        aggField: "amount",
      },
    ];

    const result = buildCreateView(mockDialect, "stats", plan, columns, resolveFieldRef);
    expect(result).toContain("GROUP BY [orders].[category], [orders].[region]");
  });

  it("omits GROUP BY when all columns are aggregates", () => {
    const plan: TViewPlan = {
      entryType: stubType,
      entryTable: "orders",
      joins: [],
      materialized: false,
    };
    const columns: TViewColumnMapping[] = [
      {
        viewColumn: "total",
        sourceTable: "orders",
        sourceColumn: "amount",
        aggFn: "sum",
        aggField: "amount",
      },
      {
        viewColumn: "cnt",
        sourceTable: "orders",
        sourceColumn: "*",
        aggFn: "count",
        aggField: "*",
      },
    ];

    const result = buildCreateView(mockDialect, "totals", plan, columns, resolveFieldRef);
    expect(result).not.toContain("GROUP BY");
  });

  it("generates HAVING clause with aggregate expression expansion", () => {
    const plan: TViewPlan = {
      entryType: stubType,
      entryTable: "orders",
      joins: [],
      having: {
        left: { field: "totalRevenue" },
        op: "$gt",
        right: 100,
      },
      materialized: false,
    };
    const columns: TViewColumnMapping[] = [
      { viewColumn: "category", sourceTable: "orders", sourceColumn: "category" },
      {
        viewColumn: "totalRevenue",
        sourceTable: "orders",
        sourceColumn: "amount",
        aggFn: "sum",
        aggField: "amount",
      },
    ];

    const result = buildCreateView(mockDialect, "order_stats", plan, columns, resolveFieldRef);
    expect(result).toContain("HAVING SUM([orders].[amount]) > 100");
  });

  it("generates full aggregate view SQL (SELECT + GROUP BY + HAVING)", () => {
    const plan: TViewPlan = {
      entryType: stubType,
      entryTable: "orders",
      joins: [],
      having: {
        left: { field: "totalRevenue" },
        op: "$gt",
        right: 100,
      },
      materialized: false,
    };
    const columns: TViewColumnMapping[] = [
      { viewColumn: "category", sourceTable: "orders", sourceColumn: "category" },
      {
        viewColumn: "totalRevenue",
        sourceTable: "orders",
        sourceColumn: "amount",
        aggFn: "sum",
        aggField: "amount",
      },
      {
        viewColumn: "orderCount",
        sourceTable: "orders",
        sourceColumn: "*",
        aggFn: "count",
        aggField: "*",
      },
      {
        viewColumn: "avgAmount",
        sourceTable: "orders",
        sourceColumn: "amount",
        aggFn: "avg",
        aggField: "amount",
      },
    ];

    const result = buildCreateView(mockDialect, "order_stats", plan, columns, resolveFieldRef);
    expect(result).toBe(
      "CREATE VIEW [order_stats] AS SELECT [orders].[category] AS [category], SUM([orders].[amount]) AS [totalRevenue], COUNT(*) AS [orderCount], AVG([orders].[amount]) AS [avgAmount] FROM [orders] GROUP BY [orders].[category] HAVING SUM([orders].[amount]) > 100",
    );
  });
});
