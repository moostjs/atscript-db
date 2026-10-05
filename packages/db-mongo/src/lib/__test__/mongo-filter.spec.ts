import { describe, it, expect } from "vite-plus/test";

import { buildMongoFilter } from "../mongo-filter";

describe("buildMongoFilter", () => {
  it("passes an empty $in / $nin through natively (match none / match all)", () => {
    expect(buildMongoFilter({ status: { $in: [] } })).toEqual({ status: { $in: [] } });
    expect(buildMongoFilter({ status: { $nin: [] } })).toEqual({ status: { $nin: [] } });
  });

  it("should return empty for empty filter", () => {
    expect(buildMongoFilter({})).toEqual({});
  });

  it("should handle simple equality", () => {
    expect(buildMongoFilter({ name: "Alice" })).toEqual({ name: "Alice" });
  });

  it("should pass through raw $regex string", () => {
    expect(buildMongoFilter({ name: { $regex: "^Ali" } })).toEqual({
      name: { $regex: "^Ali" },
    });
  });

  it("should parse /pattern/flags format into $regex + $options", () => {
    expect(buildMongoFilter({ name: { $regex: "/^Ali/i" } })).toEqual({
      name: { $regex: "^Ali", $options: "i" },
    });
  });

  it("should parse /pattern/ format without flags", () => {
    expect(buildMongoFilter({ name: { $regex: "/^Ali/" } })).toEqual({
      name: { $regex: "^Ali" },
    });
  });

  it("should handle RegExp objects", () => {
    expect(buildMongoFilter({ name: { $regex: /^Ali/i } })).toEqual({
      name: { $regex: "^Ali", $options: "i" },
    });
  });

  it("should handle RegExp objects without flags", () => {
    expect(buildMongoFilter({ name: { $regex: /^Ali/ } })).toEqual({
      name: { $regex: "^Ali" },
    });
  });
});

// ── Finding 34: mixed comparison + logical nodes (uniqu ≥ 0.1.8 implicit AND) ──
describe("buildMongoFilter — mixed comparison + logical nodes", () => {
  it("ANDs sibling fields with the $or in key insertion order (three children → $and)", () => {
    expect(
      buildMongoFilter({ id: 101, nextRefreshAt: { $lte: 5 }, $or: [{ a: 1 }, { b: 2 }] } as any),
    ).toEqual({
      $and: [{ id: 101 }, { nextRefreshAt: { $lte: 5 } }, { $or: [{ a: 1 }, { b: 2 }] }],
    });
  });

  it("a single field next to a $not keeps both predicates", () => {
    expect(buildMongoFilter({ $not: { s: 1 }, id: 101 } as any)).toEqual({
      $and: [{ $nor: [{ s: 1 }] }, { id: 101 }],
    });
  });
});

// ── $exists: "holds a value" across adapters (since 0.1.132) ──────────────────
describe("buildMongoFilter — $exists follows the null model (SQL IS [NOT] NULL parity)", () => {
  it("$exists: true → $ne: null (present and non-null); false → null (null or missing)", () => {
    expect(buildMongoFilter({ metrics: { $exists: true } })).toEqual({ metrics: { $ne: null } });
    expect(buildMongoFilter({ metrics: { $exists: false } })).toEqual({ metrics: null });
  });

  it("composes under $not / $or and beside other operators on the same field", () => {
    expect(buildMongoFilter({ $not: { a: { $exists: true } } } as any)).toEqual({
      $nor: [{ a: { $ne: null } }],
    });
    expect(buildMongoFilter({ $or: [{ a: { $exists: false } }, { b: 1 }] } as any)).toEqual({
      $or: [{ a: null }, { b: 1 }],
    });
    expect(buildMongoFilter({ a: { $exists: true, $ne: 5 } })).toEqual({
      $and: [{ a: { $ne: null } }, { a: { $ne: 5 } }],
    });
  });
});

/** `qty <op> cap` with both operands guarded non-null. */
const guard = (op: string) => ({
  $expr: {
    $and: [{ $gt: ["$qty", null] }, { $gt: ["$cap", null] }, { [op]: ["$qty", "$cap"] }],
  },
});

describe("buildMongoFilter — field operands (view predicates, since 0.1.137)", () => {
  it("AND-guards every comparison so a null / missing operand never matches", () => {
    for (const op of ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"]) {
      expect(
        buildMongoFilter({ qty: { [op]: { $field: "cap" } } } as any, { fieldOperands: true }),
        op,
      ).toEqual(guard(op));
    }
  });

  it("leaves literal comparisons and request filters as they were", () => {
    expect(
      buildMongoFilter({ qty: { $gt: 1 }, cap: { $ne: { $field: "qty" } } } as any, {
        fieldOperands: true,
      }),
    ).toEqual({
      $and: [
        { qty: { $gt: 1 } },
        {
          $expr: {
            $and: [{ $gt: ["$cap", null] }, { $gt: ["$qty", null] }, { $ne: ["$cap", "$qty"] }],
          },
        },
      ],
    });
    // Without `fieldOperands` a `{ $field }` value is data, not a path
    expect(buildMongoFilter({ qty: { $eq: { $field: "cap" } } } as any)).toEqual({
      qty: { $field: "cap" },
    });
  });
});
