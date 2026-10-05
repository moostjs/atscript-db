import { describe, it, expect } from "vite-plus/test";
import { buildWhere } from "../filter-builder";
import { finalizeParams } from "@atscript/db-sql-tools";
import { pgDialect } from "../sql-builder";

describe("buildWhere (PostgreSQL)", () => {
  it("returns 1=1 for empty filter", () => {
    const result = buildWhere({});
    expect(result.sql).toBe("1=1");
    expect(result.params).toEqual([]);
  });

  it("produces equality with ? placeholder (pre-finalization)", () => {
    const result = buildWhere({ name: "Alice" });
    expect(result.sql).toBe('"name" = ?');
    expect(result.params).toEqual(["Alice"]);
  });

  it("produces $N after finalization", () => {
    const where = buildWhere({ name: "Alice", age: 30 });
    const result = finalizeParams(pgDialect, where);
    expect(result.sql).toBe('"name" = $1 AND "age" = $2');
    expect(result.params).toEqual(["Alice", 30]);
  });

  it("handles $gt, $lt operators", () => {
    const where = buildWhere({ age: { $gt: 18, $lt: 65 } });
    const result = finalizeParams(pgDialect, where);
    expect(result.sql).toBe('"age" > $1 AND "age" < $2');
    expect(result.params).toEqual([18, 65]);
  });

  it("handles $in operator", () => {
    const where = buildWhere({ status: { $in: ["active", "pending"] } });
    const result = finalizeParams(pgDialect, where);
    expect(result.sql).toBe('"status" IN ($1, $2)');
    expect(result.params).toEqual(["active", "pending"]);
  });

  it("handles $ne with null", () => {
    const result = buildWhere({ name: { $ne: null } });
    expect(result.sql).toBe('"name" IS NOT NULL');
    expect(result.params).toEqual([]);
  });

  it("handles $regex with POSIX ~ operator", () => {
    const where = buildWhere({ name: { $regex: "^Al" } });
    const result = finalizeParams(pgDialect, where);
    expect(result.sql).toBe('"name" ~ $1');
    expect(result.params).toEqual(["^Al"]);
  });

  it("handles $regex with /pattern/flags format", () => {
    const where = buildWhere({ name: { $regex: "/^Al/" } });
    const result = finalizeParams(pgDialect, where);
    expect(result.sql).toBe('"name" ~ $1');
    expect(result.params).toEqual(["^Al"]);
  });

  it("uses ~* for case-insensitive /pattern/i format", () => {
    const where = buildWhere({ name: { $regex: "/^Al/i" } });
    const result = finalizeParams(pgDialect, where);
    expect(result.sql).toBe('"name" ~* $1');
    expect(result.params).toEqual(["^Al"]);
  });

  it("uses ~* for RegExp with i flag", () => {
    const where = buildWhere({ name: { $regex: /^Al/i } });
    const result = finalizeParams(pgDialect, where);
    expect(result.sql).toBe('"name" ~* $1');
    expect(result.params).toEqual(["^Al"]);
  });

  it("handles $or", () => {
    const where = buildWhere({ $or: [{ name: "A" }, { name: "B" }] });
    const result = finalizeParams(pgDialect, where);
    expect(result.sql).toBe('("name" = $1 OR "name" = $2)');
    expect(result.params).toEqual(["A", "B"]);
  });

  // Empty membership (since 0.1.148 round-trip fix: `field{}` / `field!{}` URLs):
  // an empty IN matches nothing, an empty NOT IN excludes nothing — never `IN ()`.
  it("renders an empty $in as 0=1 (matches nothing) and never emits IN ()", () => {
    const result = finalizeParams(pgDialect, buildWhere({ status: { $in: [] } }));
    expect(result.sql).toBe("0=1");
    expect(result.params).toEqual([]);
  });

  it("renders an empty $nin as 1=1 (excludes nothing)", () => {
    const result = finalizeParams(pgDialect, buildWhere({ status: { $nin: [] } }));
    expect(result.sql).toBe("1=1");
    expect(result.params).toEqual([]);
  });

  it("empty membership composes: AND/OR/NOT keep their meaning", () => {
    expect(
      finalizeParams(pgDialect, buildWhere({ status: { $in: [] }, priority: "high" })).sql,
    ).toBe('0=1 AND "priority" = $1');
    expect(
      finalizeParams(
        pgDialect,
        buildWhere({ $or: [{ status: { $in: [] } }, { priority: "high" }] }),
      ).sql,
    ).toContain("0=1");
  });
});
