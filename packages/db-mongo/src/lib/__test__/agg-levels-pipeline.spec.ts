import { describe, it, expect } from "vite-plus/test";
import { type DbControls, type DbQuery, UniquSelect } from "@atscript/db";

import {
  aggregateOptions,
  buildAggregatePipeline,
  buildCountPipeline,
  buildMatchedProbe,
  emptyGroupRow,
} from "../../agg";
import { whereToExpr } from "../mongo-view-expr";

// Pipeline shapes of countDistinct over a field list, conditional aggregates
// (`$where` → `$cond` inside the accumulators) and two-level aggregates
// (`$from` → the inner level's grouped stages, then the outer level's), since
// 0.1.168. Behaviour on a real server: aggregate-levels.spec.ts.

function level(
  select: unknown[],
  groupBy: string[],
  extra: Record<string, unknown> = {},
  computed?: ConstructorParameters<typeof UniquSelect>[3],
): DbControls {
  return {
    $groupBy: groupBy,
    $select: new UniquSelect(select as never, undefined, undefined, computed),
    ...extra,
  } as DbControls;
}

const query = (controls: DbControls, filter: Record<string, unknown> = {}): DbQuery =>
  ({ filter, controls }) as DbQuery;

const stageOf = (pipeline: Array<Record<string, any>>, name: string, nth = 0) =>
  pipeline.filter((s) => name in s)[nth]![name];

/** The condition `{ status: "paid" }` as the accumulators receive it (its shape: the whereToExpr cases below). */
const PAID = whereToExpr({ status: "paid" });

describe("conditional aggregates", () => {
  it("a conditional sum feeds $cond to the accumulator and counts only matching non-null values", () => {
    const pipeline = buildAggregatePipeline(
      query(
        level(
          ["region", { $fn: "sum", $field: "amount_cents", $where: { status: "paid" }, $as: "t" }],
          ["region"],
        ),
      ),
    );
    const group = stageOf(pipeline, "$group");
    expect(group.t).toEqual({ $sum: { $cond: [PAID, "$amount_cents", null] } });
    expect(group.__as_n_t).toEqual({
      $sum: { $cond: [{ $and: [PAID, { $gt: ["$amount_cents", null] }] }, 1, 0] },
    });
    expect(stageOf(pipeline, "$project").t).toEqual({
      $cond: [{ $eq: ["$__as_n_t", 0] }, null, "$t"],
    });
  });

  it("counts, distinct counts and expression aggregates take the condition too", () => {
    const pipeline = buildAggregatePipeline(
      query(
        level(
          [
            { $fn: "count", $field: "*", $where: { status: "paid" }, $as: "n" },
            { $fn: "count", $field: "qty", $where: { status: "paid" }, $as: "nq" },
            { $fn: "countDistinct", $field: "customerId", $where: { status: "paid" }, $as: "d" },
          ],
          [],
          {},
          {
            exprAggregates: [
              {
                fn: "sum",
                alias: "v",
                expr: { op: "*", args: [{ field: "amount_cents" }, { field: "qty" }] } as never,
                names: ["amount_cents", "qty"],
                where: { status: "paid" },
              },
            ],
          },
        ),
      ),
    );
    const group = stageOf(pipeline, "$group");
    expect(group.n).toEqual({ $sum: { $cond: [PAID, 1, 0] } });
    expect(group.nq).toEqual({
      $sum: { $cond: [{ $and: [PAID, { $gt: ["$qty", null] }] }, 1, 0] },
    });
    expect(group.d).toEqual({
      $addToSet: { $ifNull: [{ $cond: [PAID, "$customerId", null] }, "$$REMOVE"] },
    });
    const value = { $multiply: [{ $toDouble: "$amount_cents" }, { $toDouble: "$qty" }] };
    expect(group.v).toEqual({ $sum: { $cond: [PAID, value, null] } });
    expect(group.__as_n_v).toEqual({
      $sum: { $cond: [{ $and: [PAID, { $gt: [value, null] }] }, 1, 0] },
    });
  });
});

describe("countDistinct over a field list", () => {
  it("adds the value array of rows whose every field is non-null, then takes the set's size", () => {
    const pipeline = buildAggregatePipeline(
      query(
        level(
          [
            "region",
            { $fn: "countDistinct", $field: ["customerId", "shipping.city"], $as: "p" },
            {
              $fn: "countDistinct",
              $field: ["customerId", "productId"],
              $where: { status: "paid" },
              $as: "pp",
            },
          ],
          ["region"],
        ),
      ),
    );
    const group = stageOf(pipeline, "$group");
    expect(group.p).toEqual({
      $addToSet: {
        $cond: [
          { $and: [{ $gt: ["$customerId", null] }, { $gt: ["$shipping.city", null] }] },
          ["$customerId", "$shipping.city"],
          "$$REMOVE",
        ],
      },
    });
    expect(group.pp.$addToSet.$cond[0]).toEqual({
      $and: [{ $gt: ["$customerId", null] }, { $gt: ["$productId", null] }, PAID],
    });
    const project = stageOf(pipeline, "$project");
    expect(project.p).toEqual({ $size: "$p" });
    expect(project.pp).toEqual({ $size: "$pp" });
  });
});

describe("two-level aggregates ($from)", () => {
  const inner = level(
    ["region", "customerId", { $fn: "sum", $field: "amount_cents", $as: "spent" }],
    ["region", "customerId"],
    { $having: { spent: { $gt: 0 } } },
  );
  const outer = level(["region", { $fn: "count", $field: "*", $as: "customers" }], ["region"], {
    $from: inner,
    $having: { customers: { $gt: 1 } },
    $sort: { customers: -1 },
    $limit: 5,
  });

  it("runs the inner level's stages, then groups their documents by the outer keys", () => {
    const pipeline = buildAggregatePipeline(query(outer, { status: "paid" }));
    expect(pipeline.map((s) => Object.keys(s)[0])).toEqual([
      "$match", // the query filter — inner rows only
      "$group",
      "$project",
      "$match", // inner $having
      "$group",
      "$project",
      "$match", // outer $having
      "$sort",
      "$limit",
    ]);
    expect(pipeline[0]).toEqual({ $match: { status: "paid" } });
    expect(stageOf(pipeline, "$group", 0)._id).toEqual({
      k0: { $ifNull: ["$region", null] },
      k1: { $ifNull: ["$customerId", null] },
    });
    expect(stageOf(pipeline, "$project", 0)).toMatchObject({
      region: "$_id.k0",
      customerId: "$_id.k1",
    });
    expect(stageOf(pipeline, "$group", 1)).toEqual({
      _id: { k0: { $ifNull: ["$region", null] } },
      customers: { $sum: 1 },
    });
    expect(stageOf(pipeline, "$match", 1)).toEqual({ spent: { $gt: 0 } });
    expect(stageOf(pipeline, "$match", 2)).toEqual({ customers: { $gt: 1 } });
    expect(aggregateOptions(pipeline)).toEqual({ allowDiskUse: true });
  });

  it("counts the outer groups over the inner stages; probes for any inner row", () => {
    const count = buildCountPipeline(query({ ...outer, $having: undefined }));
    expect(count.map((s) => Object.keys(s)[0])).toEqual([
      "$match",
      "$group",
      "$project",
      "$match",
      "$group",
      "$count",
    ]);
    expect(buildMatchedProbe(query(outer)).map((s) => Object.keys(s)[0])).toEqual([
      "$match",
      "$group",
      "$project",
      "$match",
      "$limit",
      "$project",
    ]);
  });

  it("reads a nested inner key at its path and sorts inner rows by $rowOrder before the outer $group", () => {
    const nestedInner = level(
      ["shipping.city", "region", { $fn: "count", $field: "*", $as: "n" }],
      ["shipping.city", "region"],
    );
    const pipeline = buildAggregatePipeline(
      query(
        level(
          ["shipping.city", { $fn: "first", $field: "region", $as: "top" }],
          ["shipping.city"],
          { $from: nestedInner },
          {
            rowOrder: [
              { column: "n", desc: true },
              { column: "shipping.city", desc: false },
              { column: "region", desc: false },
            ],
          },
        ),
      ),
    );
    expect(pipeline.map((s) => Object.keys(s)[0])).toEqual([
      "$match",
      "$group",
      "$project",
      "$sort",
      "$group",
      "$project",
    ]);
    expect(stageOf(pipeline, "$project", 0)).toMatchObject({ "shipping.city": "$_id.k0" });
    expect(stageOf(pipeline, "$sort")).toEqual({ n: -1, "shipping.city": 1, region: 1 });
    expect(stageOf(pipeline, "$group", 1)._id).toEqual({
      k0: { $ifNull: ["$shipping.city", null] },
    });
    expect(stageOf(pipeline, "$project", 1)).toMatchObject({ "shipping.city": "$_id.k0" });
  });

  it("an ungrouped outer level yields the empty-group row: counts 0, others null", () => {
    expect(
      emptyGroupRow(
        query(
          level(
            [
              { $fn: "count", $field: "*", $as: "groups" },
              { $fn: "sum", $field: "spent", $where: { spent: { $gt: 1 } }, $as: "s" },
              { $fn: "countDistinct", $field: ["region", "customerId"], $as: "p" },
            ],
            [],
            { $from: inner },
          ),
        ),
      ),
    ).toEqual({ groups: 0, s: null, p: 0 });
  });
});

describe("whereToExpr — the MongoDB filter's reading", () => {
  it("never answers a bare boolean: an always-false condition still restricts the accumulator", () => {
    for (const where of [
      { a: { $in: [] } },
      { $or: [] },
      { a: { $gt: null } },
      { a: { $lt: null } },
    ]) {
      expect(whereToExpr(where as never), JSON.stringify(where)).toEqual({ $literal: false });
    }
    expect(whereToExpr({})).toEqual({ $literal: true });
    expect(whereToExpr({ a: { $nin: [] } })).toEqual({ $not: [{ $literal: false }] });
    const pipeline = buildAggregatePipeline(
      query(
        level(
          [
            { $fn: "count", $field: "*", $where: { a: { $in: [] } }, $as: "n" },
            { $fn: "sum", $field: "v", $where: { $or: [] }, $as: "s" },
          ],
          [],
        ),
      ),
    );
    const group = stageOf(pipeline, "$group");
    expect(group.n).toEqual({ $sum: { $cond: [{ $literal: false }, 1, 0] } });
    expect(group.s).toEqual({ $sum: { $cond: [{ $literal: false }, "$v", null] } });
  });

  it("= v / $in match an equal value or an array holding one; = null also null, missing and an array holding null", () => {
    expect(whereToExpr({ a: "x" })).toEqual({
      $cond: [{ $isArray: "$a" }, { $in: ["x", "$a"] }, { $eq: ["$a", "x"] }],
    });
    expect(whereToExpr({ a: null })).toEqual({
      $cond: [{ $isArray: "$a" }, { $in: [null, "$a"] }, { $lte: ["$a", null] }],
    });
    expect(whereToExpr({ a: { $exists: true } })).toEqual({ $not: [whereToExpr({ a: null })] });
    expect(whereToExpr({ a: { $in: [1, null] } })).toEqual({
      $or: [whereToExpr({ a: 1 }), whereToExpr({ a: null })],
    });
  });

  it("$ne / $nin / $not are the plain negation (they match a null or missing value)", () => {
    expect(whereToExpr({ a: { $ne: "x" } })).toEqual({ $not: [whereToExpr({ a: "x" })] });
    expect(whereToExpr({ a: { $nin: [1, 2] } })).toEqual({
      $not: [{ $or: [whereToExpr({ a: 1 }), whereToExpr({ a: 2 })] }],
    });
    expect(whereToExpr({ $not: { a: { $gt: 1 } } })).toEqual({
      $not: [whereToExpr({ a: { $gt: 1 } })],
    });
  });

  it("ranges compare values of the operand's type class only, any element of an array", () => {
    expect(whereToExpr({ a: { $gt: 1 } })).toEqual({
      $cond: [
        { $isArray: "$a" },
        {
          $anyElementTrue: [
            {
              $map: {
                input: "$a",
                as: "v",
                in: { $and: [{ $isNumber: "$$v" }, { $gt: ["$$v", 1] }] },
              },
            },
          ],
        },
        { $and: [{ $isNumber: "$a" }, { $gt: ["$a", 1] }] },
      ],
    });
    expect(whereToExpr({ a: { $gte: null } })).toEqual(whereToExpr({ a: null }));
  });

  it("matches $regex with $regexMatch on strings only; $-strings and objects stay literals", () => {
    const one = (input: string) => ({
      $cond: [
        { $eq: [{ $type: input }, "string"] },
        { $regexMatch: { input, regex: "^pa", options: "i" } },
        false,
      ],
    });
    expect(whereToExpr({ a: { $regex: "/^pa/ig" } })).toEqual({
      $cond: [
        { $isArray: "$a" },
        { $anyElementTrue: [{ $map: { input: "$a", as: "v", in: one("$$v") } }] },
        one("$a"),
      ],
    });
    expect(JSON.stringify(whereToExpr({ a: "$b" }))).toContain('{"$literal":"$b"}');
    const obj = { $toUpper: "$secret" };
    expect(JSON.stringify(whereToExpr({ a: { $in: [obj] } } as never))).toContain(
      JSON.stringify({ $literal: obj }),
    );
    expect(whereToExpr({ "shipping.city": "Oslo" })).toEqual({
      $cond: [
        { $isArray: "$shipping.city" },
        { $in: ["Oslo", "$shipping.city"] },
        { $eq: ["$shipping.city", "Oslo"] },
      ],
    });
  });
});
