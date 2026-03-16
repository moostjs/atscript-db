/* eslint-disable unicorn/consistent-function-scoping */
import { describe, it, expect } from "vite-plus/test";

import {
  sqlStringLiteral,
  toSqlValue,
  refActionToSql,
  defaultValueForType,
  queryNodeToSql,
} from "../common";
import type { AtscriptQueryFieldRef } from "@atscript/db";

describe("sqlStringLiteral", () => {
  it("wraps a plain string in single quotes", () => {
    expect(sqlStringLiteral("hello")).toBe("'hello'");
  });

  it("escapes single quotes by doubling them", () => {
    expect(sqlStringLiteral("it's")).toBe("'it''s'");
  });

  it("handles multiple single quotes", () => {
    expect(sqlStringLiteral("a'b'c")).toBe("'a''b''c'");
  });

  it("handles empty string", () => {
    expect(sqlStringLiteral("")).toBe("''");
  });
});

describe("toSqlValue", () => {
  it("converts undefined to null", () => {
    expect(toSqlValue(undefined)).toBeNull();
  });

  it("converts null to null", () => {
    expect(toSqlValue(null)).toBeNull();
  });

  it("converts objects to JSON strings", () => {
    expect(toSqlValue({ a: 1 })).toBe('{"a":1}');
  });

  it("converts arrays to JSON strings", () => {
    expect(toSqlValue([1, 2, 3])).toBe("[1,2,3]");
  });

  it("converts true to 1", () => {
    expect(toSqlValue(true)).toBe(1);
  });

  it("converts false to 0", () => {
    expect(toSqlValue(false)).toBe(0);
  });

  it("passes numbers through", () => {
    expect(toSqlValue(42)).toBe(42);
  });

  it("passes strings through", () => {
    expect(toSqlValue("hello")).toBe("hello");
  });
});

describe("refActionToSql", () => {
  it("maps cascade", () => {
    expect(refActionToSql("cascade")).toBe("CASCADE");
  });

  it("maps restrict", () => {
    expect(refActionToSql("restrict")).toBe("RESTRICT");
  });

  it("maps setNull", () => {
    expect(refActionToSql("setNull")).toBe("SET NULL");
  });

  it("maps setDefault", () => {
    expect(refActionToSql("setDefault")).toBe("SET DEFAULT");
  });

  it("defaults to NO ACTION for unknown values", () => {
    expect(refActionToSql("noAction" as any)).toBe("NO ACTION");
    expect(refActionToSql("unknown" as any)).toBe("NO ACTION");
  });
});

describe("defaultValueForType", () => {
  it("returns 0 for number", () => {
    expect(defaultValueForType("number")).toBe("0");
  });

  it("returns 0 for integer", () => {
    expect(defaultValueForType("integer")).toBe("0");
  });

  it("returns 0 for boolean", () => {
    expect(defaultValueForType("boolean")).toBe("0");
  });

  it("returns '' for string", () => {
    expect(defaultValueForType("string")).toBe("''");
  });

  it("returns '' for unknown types", () => {
    expect(defaultValueForType("date")).toBe("''");
  });
});

describe("queryNodeToSql", () => {
  const resolveFieldRef = (ref: AtscriptQueryFieldRef) => `[${(ref as any).table}].[${ref.field}]`;

  it("renders a simple $eq comparison", () => {
    const node = { left: { table: "t", field: "id" }, op: "$eq", right: 5 };
    expect(queryNodeToSql(node, resolveFieldRef)).toBe("[t].[id] = 5");
  });

  it("renders a string comparison with quote escaping", () => {
    const node = { left: { table: "t", field: "name" }, op: "$eq", right: "O'Brien" };
    expect(queryNodeToSql(node, resolveFieldRef)).toBe("[t].[name] = 'O''Brien'");
  });

  it("renders IS NULL for null right value", () => {
    const node = { left: { table: "t", field: "col" }, op: "$eq", right: null };
    expect(queryNodeToSql(node, resolveFieldRef)).toBe("[t].[col] IS NULL");
  });

  it("renders IS NOT NULL for $ne with null right value", () => {
    const node = { left: { table: "t", field: "col" }, op: "$ne", right: null };
    expect(queryNodeToSql(node, resolveFieldRef)).toBe("[t].[col] IS NOT NULL");
  });

  it("renders field-to-field comparison", () => {
    const node = {
      left: { table: "a", field: "id" },
      op: "$eq",
      right: { table: "b", field: "a_id" },
    };
    expect(queryNodeToSql(node, resolveFieldRef)).toBe("[a].[id] = [b].[a_id]");
  });

  it("renders $and", () => {
    const node = {
      $and: [
        { left: { table: "t", field: "x" }, op: "$gt", right: 1 },
        { left: { table: "t", field: "y" }, op: "$lt", right: 10 },
      ],
    };
    expect(queryNodeToSql(node, resolveFieldRef)).toBe("[t].[x] > 1 AND [t].[y] < 10");
  });

  it("renders $or", () => {
    const node = {
      $or: [
        { left: { table: "t", field: "a" }, op: "$eq", right: 1 },
        { left: { table: "t", field: "b" }, op: "$eq", right: 2 },
      ],
    };
    expect(queryNodeToSql(node, resolveFieldRef)).toBe("([t].[a] = 1 OR [t].[b] = 2)");
  });

  it("renders $not", () => {
    const node = {
      $not: { left: { table: "t", field: "active" }, op: "$eq", right: 0 },
    };
    expect(queryNodeToSql(node, resolveFieldRef)).toBe("NOT ([t].[active] = 0)");
  });

  it("uses default = for unknown operators", () => {
    const node = { left: { table: "t", field: "x" }, op: "$unknown", right: 42 };
    expect(queryNodeToSql(node, resolveFieldRef)).toBe("[t].[x] = 42");
  });
});
