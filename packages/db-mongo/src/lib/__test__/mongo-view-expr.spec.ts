import { describe, it, expect } from "vite-plus/test";

import { exprToMongo, isNullExpr, notNullExpr, queryNodeToExpr } from "../mongo-view-expr";

// View predicate → aggregation expression with SQL null semantics (since 0.1.136).

const pathOf = (ref: { field: string }) => `$${ref.field}`;
const f = (field: string) => ({ field });

describe("queryNodeToExpr", () => {
  it("guards ordering comparisons and != <literal> against null / missing", () => {
    expect(queryNodeToExpr({ left: f("a"), op: "$gt", right: 5 }, pathOf)).toEqual({
      $and: [notNullExpr("$a"), { $gt: ["$a", 5] }],
    });
    expect(queryNodeToExpr({ left: f("a"), op: "$ne", right: "x" }, pathOf)).toEqual({
      $and: [notNullExpr("$a"), { $ne: ["$a", "x"] }],
    });
  });

  it("compares = <literal> directly and guards field = field on both sides", () => {
    expect(queryNodeToExpr({ left: f("a"), op: "$eq", right: 1 }, pathOf)).toEqual({
      $eq: ["$a", 1],
    });
    expect(queryNodeToExpr({ left: f("a"), op: "$eq", right: f("b") }, pathOf)).toEqual({
      $and: [notNullExpr("$a"), notNullExpr("$b"), { $eq: ["$a", "$b"] }],
    });
  });

  it("maps null comparisons and exists", () => {
    expect(queryNodeToExpr({ left: f("a"), op: "$eq", right: null }, pathOf)).toEqual(
      isNullExpr("$a"),
    );
    expect(queryNodeToExpr({ left: f("a"), op: "$ne", right: null }, pathOf)).toEqual(
      notNullExpr("$a"),
    );
    expect(queryNodeToExpr({ left: f("a"), op: "$exists", right: true }, pathOf)).toEqual(
      notNullExpr("$a"),
    );
    expect(queryNodeToExpr({ left: f("a"), op: "$exists", right: false }, pathOf)).toEqual(
      isNullExpr("$a"),
    );
  });

  it("renders in / not in (guarded) and escapes $-strings as literals", () => {
    expect(queryNodeToExpr({ left: f("a"), op: "$in", right: ["x", "$y"] }, pathOf)).toEqual({
      $in: ["$a", ["x", { $literal: "$y" }]],
    });
    expect(queryNodeToExpr({ left: f("a"), op: "$nin", right: [1] }, pathOf)).toEqual({
      $and: [notNullExpr("$a"), { $not: [{ $in: ["$a", [1]] }] }],
    });
    expect(queryNodeToExpr({ left: f("a"), op: "$nin", right: [] }, pathOf)).toEqual({
      $literal: true,
    });
  });

  it("maps and / or / not and rejects matches", () => {
    expect(
      queryNodeToExpr(
        {
          $or: [
            { $not: { left: f("a"), op: "$eq", right: 1 } },
            { $and: [{ left: f("b"), op: "$eq", right: 2 }] },
          ],
        },
        pathOf,
      ),
    ).toEqual({ $or: [{ $not: [{ $eq: ["$a", 1] }] }, { $and: [{ $eq: ["$b", 2] }] }] });
    expect(() => queryNodeToExpr({ left: f("a"), op: "$regex", right: "^x" }, pathOf)).toThrow(
      "matches is not supported in view predicates",
    );
  });
});

// Computed view columns (since 0.1.147).
describe("exprToMongo", () => {
  const leaf = (path: string) => `$${path}`;

  it("maps arithmetic, guards division by zero and negates by multiplication", () => {
    expect(
      exprToMongo(
        {
          op: "+",
          args: [
            { op: "*", args: [{ field: "a" }, 10] },
            { op: "neg", args: [{ field: "b" }] },
          ],
        },
        leaf,
      ),
    ).toEqual({
      $add: [{ $multiply: ["$a", { $literal: 10 }] }, { $multiply: [-1, "$b"] }],
    });
    expect(exprToMongo({ op: "/", args: [{ field: "a" }, { field: "b" }] }, leaf)).toEqual({
      $cond: [{ $eq: ["$b", 0] }, null, { $divide: ["$a", "$b"] }],
    });
    expect(exprToMongo({ op: "-", args: [{ field: "a" }, -1] }, leaf)).toEqual({
      $subtract: ["$a", { $literal: -1 }],
    });
  });

  it("nests two-argument $ifNull for coalesce", () => {
    expect(
      exprToMongo({ op: "coalesce", args: [{ field: "a" }, { field: "b" }, 0] }, leaf),
    ).toEqual({
      $ifNull: ["$a", { $ifNull: ["$b", { $literal: 0 }] }],
    });
  });
});
