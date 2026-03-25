import { describe, it, expect } from "vite-plus/test";

import { buildWhere } from "../filter-builder";

describe("buildWhere (MySQL)", () => {
  // ── Empty / trivial ────────────────────────────────────────────────────

  it("should return 1=1 for empty filter", () => {
    expect(buildWhere({})).toEqual({ sql: "1=1", params: [] });
  });

  it("should return 1=1 for null/undefined filter", () => {
    expect(buildWhere(null as any)).toEqual({ sql: "1=1", params: [] });
  });

  // ── Equality ───────────────────────────────────────────────────────────

  it("should handle simple equality with backtick quoting", () => {
    const { sql, params } = buildWhere({ name: "John" });
    expect(sql).toBe("`name` = ?");
    expect(params).toEqual(["John"]);
  });

  it("should handle multiple equalities with AND", () => {
    const { sql, params } = buildWhere({ name: "John", age: 30 });
    expect(sql).toBe("`name` = ? AND `age` = ?");
    expect(params).toEqual(["John", 30]);
  });

  it("should handle null equality", () => {
    const { sql, params } = buildWhere({ name: null });
    expect(sql).toBe("`name` IS NULL");
    expect(params).toEqual([]);
  });

  // ── Comparison operators ───────────────────────────────────────────────

  it("should handle $gt", () => {
    const { sql, params } = buildWhere({ age: { $gt: 18 } });
    expect(sql).toBe("`age` > ?");
    expect(params).toEqual([18]);
  });

  it("should handle $gte", () => {
    const { sql, params } = buildWhere({ age: { $gte: 18 } });
    expect(sql).toBe("`age` >= ?");
    expect(params).toEqual([18]);
  });

  it("should handle $lt", () => {
    const { sql, params } = buildWhere({ age: { $lt: 65 } });
    expect(sql).toBe("`age` < ?");
    expect(params).toEqual([65]);
  });

  it("should handle $lte", () => {
    const { sql, params } = buildWhere({ age: { $lte: 65 } });
    expect(sql).toBe("`age` <= ?");
    expect(params).toEqual([65]);
  });

  it("should handle $ne", () => {
    const { sql, params } = buildWhere({ status: { $ne: "banned" } });
    expect(sql).toBe("`status` != ?");
    expect(params).toEqual(["banned"]);
  });

  it("should handle $ne with null", () => {
    const { sql, params } = buildWhere({ status: { $ne: null } });
    expect(sql).toBe("`status` IS NOT NULL");
    expect(params).toEqual([]);
  });

  it("should handle multiple operators on same field", () => {
    const { sql, params } = buildWhere({ age: { $gte: 18, $lt: 65 } });
    expect(sql).toBe("`age` >= ? AND `age` < ?");
    expect(params).toEqual([18, 65]);
  });

  // ── Set operators ──────────────────────────────────────────────────────

  it("should handle $in", () => {
    const { sql, params } = buildWhere({ status: { $in: ["active", "pending"] } });
    expect(sql).toBe("`status` IN (?, ?)");
    expect(params).toEqual(["active", "pending"]);
  });

  it("should handle $in with empty array", () => {
    const { sql, params } = buildWhere({ status: { $in: [] } });
    expect(sql).toBe("0=1");
    expect(params).toEqual([]);
  });

  it("should handle $nin", () => {
    const { sql, params } = buildWhere({ status: { $nin: ["banned", "deleted"] } });
    expect(sql).toBe("`status` NOT IN (?, ?)");
    expect(params).toEqual(["banned", "deleted"]);
  });

  it("should handle $nin with empty array", () => {
    const { sql, params } = buildWhere({ status: { $nin: [] } });
    expect(sql).toBe("1=1");
    expect(params).toEqual([]);
  });

  // ── Existence ──────────────────────────────────────────────────────────

  it("should handle $exists: true", () => {
    const { sql, params } = buildWhere({ email: { $exists: true } });
    expect(sql).toBe("`email` IS NOT NULL");
    expect(params).toEqual([]);
  });

  it("should handle $exists: false", () => {
    const { sql, params } = buildWhere({ email: { $exists: false } });
    expect(sql).toBe("`email` IS NULL");
    expect(params).toEqual([]);
  });

  // ── Regex (MySQL native REGEXP) ────────────────────────────────────────

  it("should use native REGEXP for $regex", () => {
    const { sql, params } = buildWhere({ name: { $regex: "^John" } });
    expect(sql).toBe("`name` REGEXP ?");
    expect(params).toEqual(["^John"]);
  });

  it("should use native REGEXP for $regex with RegExp object", () => {
    const { sql, params } = buildWhere({ name: { $regex: /John/i } });
    expect(sql).toBe("`name` REGEXP ?");
    expect(params).toEqual(["John"]);
  });

  it("should parse /pattern/flags format and extract raw pattern", () => {
    const { sql, params } = buildWhere({ name: { $regex: "/^John/" } });
    expect(sql).toBe("`name` REGEXP ?");
    expect(params).toEqual(["^John"]);
  });

  it("should strip flags from /pattern/flags format", () => {
    const { sql, params } = buildWhere({ name: { $regex: "/^John/i" } });
    expect(sql).toBe("`name` REGEXP ?");
    expect(params).toEqual(["^John"]);
  });

  // ── Logical operators ──────────────────────────────────────────────────

  it("should handle $and", () => {
    const { sql, params } = buildWhere({
      $and: [{ name: "John" }, { age: { $gt: 18 } }],
    });
    expect(sql).toBe("`name` = ? AND `age` > ?");
    expect(params).toEqual(["John", 18]);
  });

  it("should handle $or", () => {
    const { sql, params } = buildWhere({
      $or: [{ status: "active" }, { status: "pending" }],
    });
    expect(sql).toBe("(`status` = ? OR `status` = ?)");
    expect(params).toEqual(["active", "pending"]);
  });

  it("should handle $not", () => {
    const { sql, params } = buildWhere({
      $not: { status: "banned" },
    });
    expect(sql).toBe("NOT (`status` = ?)");
    expect(params).toEqual(["banned"]);
  });

  it("should handle nested logical operators", () => {
    const { sql, params } = buildWhere({
      $or: [{ $and: [{ name: "John" }, { age: { $gt: 18 } }] }, { status: "admin" }],
    });
    expect(sql).toBe("(`name` = ? AND `age` > ? OR `status` = ?)");
    expect(params).toEqual(["John", 18, "admin"]);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it("should throw on unsupported operator", () => {
    expect(() => buildWhere({ field: { $unknown: 1 } })).toThrow(
      "Unsupported filter operator: $unknown",
    );
  });

  it("should escape identifier with backticks", () => {
    const { sql } = buildWhere({ "my`field": "value" });
    expect(sql).toBe("`my``field` = ?");
  });

  it("should convert boolean to 0/1", () => {
    const { sql, params } = buildWhere({ active: true });
    expect(sql).toBe("`active` = ?");
    expect(params).toEqual([1]);
  });
});
