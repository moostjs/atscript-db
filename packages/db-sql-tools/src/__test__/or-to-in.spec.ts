import { describe, it, expect } from "vite-plus/test";

import { sqlStringLiteral } from "../common";
import { buildWhere } from "../filter-builder";
import type { SqlDialect } from "../dialect";

// Since 0.1.165 an `$or` of equalities on ONE field renders as `IN (…)`:
// one predicate instead of an OR chain whose depth grows with the batch (a
// per-row `{ id }` filter over ~1000 rows hit SQLite's "Expression tree is
// too large"). Branches on other fields, composite branches and operators
// keep their OR.

const d: SqlDialect = {
  quoteIdentifier: (name) => `"${name}"`,
  quoteTable: (name) => `"${name}"`,
  unlimitedLimit: "-1",
  stringLiteral: sqlStringLiteral,
  toValue: (v) => v ?? null,
  toParam: (v) => v,
  regex: (col, v) => ({ sql: `${col} LIKE ?`, params: [String(v)] }),
  createViewPrefix: "CREATE VIEW",
};

describe("$or of one field's equalities → IN", () => {
  it("collapses bare and $eq equalities", () => {
    expect(buildWhere(d, { $or: [{ id: 1 }, { id: { $eq: 2 } }, { id: 3 }] })).toEqual({
      sql: `("id" IN (?, ?, ?))`,
      params: [1, 2, 3],
    });
  });

  it("merges $in branches of the same field", () => {
    expect(buildWhere(d, { $or: [{ id: { $in: [1, 2] } }, { id: 3 }] })).toEqual({
      sql: `("id" IN (?, ?, ?))`,
      params: [1, 2, 3],
    });
  });

  it("keeps other branches next to the IN", () => {
    expect(buildWhere(d, { $or: [{ id: 1 }, { name: "x" }, { id: 2 }] })).toEqual({
      sql: `("id" IN (?, ?) OR "name" = ?)`,
      params: [1, 2, "x"],
    });
  });

  it("leaves composite branches, nulls and single equalities alone", () => {
    expect(
      buildWhere(d, {
        $or: [
          { a: 1, b: 2 },
          { a: 3, b: 4 },
        ],
      }).sql,
    ).toBe(`("a" = ? AND "b" = ? OR "a" = ? AND "b" = ?)`);
    expect(buildWhere(d, { $or: [{ a: null }, { a: 1 }] }).sql).toBe(`("a" IS NULL OR "a" = ?)`);
    expect(buildWhere(d, { $or: [{ a: 1 }] })).toEqual({ sql: `("a" = ?)`, params: [1] });
  });

  it("applies inside nested logical nodes", () => {
    expect(buildWhere(d, { $and: [{ s: "x" }, { $or: [{ id: 1 }, { id: 2 }] }] })).toEqual({
      sql: `"s" = ? AND ("id" IN (?, ?))`,
      params: ["x", 1, 2],
    });
  });

  // Review fix: MySQL compares `col IN (1, 'a')` as strings — merge only
  // when every literal has the same JS type.
  it("keeps the OR when one field's literals mix types", () => {
    expect(buildWhere(d, { $or: [{ code: 1 }, { code: "a" }] })).toEqual({
      sql: `("code" = ? OR "code" = ?)`,
      params: [1, "a"],
    });
    expect(buildWhere(d, { $or: [{ code: { $in: [1, 2] } }, { code: "3" }] }).sql).toBe(
      `("code" IN (?, ?) OR "code" = ?)`,
    );
  });
});
