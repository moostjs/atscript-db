import { describe, it, expect } from "vite-plus/test";

import { createFilterVisitor, buildWhere } from "../filter-builder";
import { EMPTY_AND, EMPTY_OR } from "../dialect";
import type { SqlDialect } from "../dialect";

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

describe("createFilterVisitor", () => {
  const visitor = createFilterVisitor(mockDialect);

  describe("comparison", () => {
    it("handles $eq with a value", () => {
      const result = visitor.comparison("name", "$eq", "Alice");
      expect(result).toEqual({ sql: "[name] = ?", params: ["Alice"] });
    });

    it("handles $eq with null", () => {
      const result = visitor.comparison("name", "$eq", null);
      expect(result).toEqual({ sql: "[name] IS NULL", params: [] });
    });

    it("handles $ne with a value", () => {
      const result = visitor.comparison("name", "$ne", "Bob");
      expect(result).toEqual({ sql: "[name] != ?", params: ["Bob"] });
    });

    it("handles $ne with null", () => {
      const result = visitor.comparison("name", "$ne", null);
      expect(result).toEqual({ sql: "[name] IS NOT NULL", params: [] });
    });

    it("handles $gt", () => {
      const result = visitor.comparison("age", "$gt", 18);
      expect(result).toEqual({ sql: "[age] > ?", params: [18] });
    });

    it("handles $gte", () => {
      const result = visitor.comparison("age", "$gte", 21);
      expect(result).toEqual({ sql: "[age] >= ?", params: [21] });
    });

    it("handles $lt", () => {
      const result = visitor.comparison("score", "$lt", 100);
      expect(result).toEqual({ sql: "[score] < ?", params: [100] });
    });

    it("handles $lte", () => {
      const result = visitor.comparison("score", "$lte", 50);
      expect(result).toEqual({ sql: "[score] <= ?", params: [50] });
    });

    it("handles $in with values", () => {
      const result = visitor.comparison("status", "$in", ["active", "pending"]);
      expect(result).toEqual({ sql: "[status] IN (?, ?)", params: ["active", "pending"] });
    });

    it("handles $in with empty array", () => {
      const result = visitor.comparison("status", "$in", []);
      expect(result).toBe(EMPTY_OR);
    });

    it("handles $nin with values", () => {
      const result = visitor.comparison("status", "$nin", ["deleted", "archived"]);
      expect(result).toEqual({ sql: "[status] NOT IN (?, ?)", params: ["deleted", "archived"] });
    });

    it("handles $nin with empty array", () => {
      const result = visitor.comparison("status", "$nin", []);
      expect(result).toBe(EMPTY_AND);
    });

    it("handles $exists true", () => {
      const result = visitor.comparison("email", "$exists", true);
      expect(result).toEqual({ sql: "[email] IS NOT NULL", params: [] });
    });

    it("handles $exists false", () => {
      const result = visitor.comparison("email", "$exists", false);
      expect(result).toEqual({ sql: "[email] IS NULL", params: [] });
    });

    it("handles $regex by delegating to dialect", () => {
      const result = visitor.comparison("name", "$regex", "^A.*");
      expect(result).toEqual({ sql: "[name] LIKE ?", params: ["^A.*"] });
    });

    it("handles boolean values via toParam", () => {
      const result = visitor.comparison("active", "$eq", true);
      expect(result).toEqual({ sql: "[active] = ?", params: [1] });
    });

    it("throws for unsupported operator", () => {
      expect(() => visitor.comparison("x", "$weird" as any, 1)).toThrow(
        "Unsupported filter operator: $weird",
      );
    });
  });

  describe("and", () => {
    it("returns EMPTY_AND for empty children", () => {
      expect(visitor.and([])).toBe(EMPTY_AND);
    });

    it("joins children with AND", () => {
      const result = visitor.and([
        { sql: "[a] = ?", params: [1] },
        { sql: "[b] > ?", params: [2] },
      ]);
      expect(result).toEqual({ sql: "[a] = ? AND [b] > ?", params: [1, 2] });
    });
  });

  describe("or", () => {
    it("returns EMPTY_OR for empty children", () => {
      expect(visitor.or([])).toBe(EMPTY_OR);
    });

    it("joins children with OR and wraps in parens", () => {
      const result = visitor.or([
        { sql: "[x] = ?", params: [10] },
        { sql: "[y] = ?", params: [20] },
      ]);
      expect(result).toEqual({ sql: "([x] = ? OR [y] = ?)", params: [10, 20] });
    });
  });

  describe("not", () => {
    it("wraps child with NOT", () => {
      const result = visitor.not({ sql: "[z] = ?", params: [0] });
      expect(result).toEqual({ sql: "NOT ([z] = ?)", params: [0] });
    });
  });
});

describe("buildWhere", () => {
  it("returns EMPTY_AND for null filter", () => {
    expect(buildWhere(mockDialect, null as any)).toEqual(EMPTY_AND);
  });

  it("returns EMPTY_AND for undefined filter", () => {
    expect(buildWhere(mockDialect, undefined as any)).toEqual(EMPTY_AND);
  });

  it("returns EMPTY_AND for empty object filter", () => {
    expect(buildWhere(mockDialect, {})).toEqual(EMPTY_AND);
  });

  it("builds a simple equality filter", () => {
    const result = buildWhere(mockDialect, { name: "Alice" });
    expect(result.sql).toBe("[name] = ?");
    expect(result.params).toEqual(["Alice"]);
  });

  it("builds a filter with $and", () => {
    const result = buildWhere(mockDialect, {
      $and: [{ age: { $gt: 18 } }, { status: "active" }],
    });
    expect(result.sql).toContain("AND");
    expect(result.params.length).toBeGreaterThan(0);
  });

  it("builds a filter with $or", () => {
    const result = buildWhere(mockDialect, {
      $or: [{ status: "active" }, { status: "pending" }],
    });
    expect(result.sql).toContain("OR");
  });
});
