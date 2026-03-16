import { describe, it, expect } from "vite-plus/test";
import type { AggregateExpr } from "@atscript/db/agg";
import { type DbQuery, UniquSelect } from "@atscript/db";
import { buildAggregatePipeline, buildCountPipeline } from "../../agg";

/** Helper: build a DbQuery with aggregate controls. */
function makeQuery(opts: {
  filter?: Record<string, unknown>;
  groupBy: string[];
  select?: Array<string | AggregateExpr>;
  sort?: Record<string, number>;
  skip?: number;
  limit?: number;
  having?: Record<string, unknown>;
  count?: boolean;
}): DbQuery {
  return {
    filter: opts.filter ?? {},
    controls: {
      $groupBy: opts.groupBy,
      $select: opts.select ? new UniquSelect(opts.select as any) : undefined,
      $sort: opts.sort as any,
      $skip: opts.skip,
      $limit: opts.limit,
      $having: opts.having as any,
      $count: opts.count,
    },
  };
}

describe("buildAggregatePipeline", () => {
  it("single dimension + single sum aggregate", () => {
    const query = makeQuery({
      groupBy: ["currency"],
      select: ["currency", { $fn: "sum", $field: "amount", $as: "total" }],
    });
    const pipeline = buildAggregatePipeline(query);

    expect(pipeline).toEqual([
      { $match: {} },
      { $group: { _id: { currency: "$currency" }, total: { $sum: "$amount" } } },
      { $project: { _id: 0, currency: "$_id.currency", total: 1 } },
    ]);
  });

  it("multiple dimensions + multiple aggregates (all 5 functions)", () => {
    const query = makeQuery({
      groupBy: ["status", "region"],
      select: [
        "status",
        "region",
        { $fn: "sum", $field: "amount", $as: "total" },
        { $fn: "count", $field: "*", $as: "cnt" },
        { $fn: "avg", $field: "amount", $as: "avgAmt" },
        { $fn: "min", $field: "amount", $as: "minAmt" },
        { $fn: "max", $field: "amount", $as: "maxAmt" },
      ],
    });
    const pipeline = buildAggregatePipeline(query);

    expect(pipeline).toEqual([
      { $match: {} },
      {
        $group: {
          _id: { status: "$status", region: "$region" },
          total: { $sum: "$amount" },
          cnt: { $sum: 1 },
          avgAmt: { $avg: "$amount" },
          minAmt: { $min: "$amount" },
          maxAmt: { $max: "$amount" },
        },
      },
      {
        $project: {
          _id: 0,
          status: "$_id.status",
          region: "$_id.region",
          total: 1,
          cnt: 1,
          avgAmt: 1,
          minAmt: 1,
          maxAmt: 1,
        },
      },
    ]);
  });

  it("count(field) maps to $cond null-check", () => {
    const query = makeQuery({
      groupBy: ["status"],
      select: ["status", { $fn: "count", $field: "email", $as: "emailCount" }],
    });
    const pipeline = buildAggregatePipeline(query);
    const groupStage = pipeline.find((s: any) => s.$group)!.$group;

    expect(groupStage.emailCount).toEqual({
      $sum: { $cond: [{ $ne: ["$email", null] }, 1, 0] },
    });
  });

  it("applies $match filter", () => {
    const query = makeQuery({
      filter: { status: "active" },
      groupBy: ["currency"],
      select: ["currency", { $fn: "sum", $field: "amount", $as: "total" }],
    });
    const pipeline = buildAggregatePipeline(query);

    expect(pipeline[0]).toEqual({ $match: { status: "active" } });
  });

  it("passes empty $match when no filter", () => {
    const query = makeQuery({
      groupBy: ["currency"],
      select: ["currency", { $fn: "sum", $field: "amount", $as: "total" }],
    });
    const pipeline = buildAggregatePipeline(query);

    expect(pipeline[0]).toEqual({ $match: {} });
    expect(pipeline[1]).toHaveProperty("$group");
  });

  it("adds $sort stage", () => {
    const query = makeQuery({
      groupBy: ["currency"],
      select: ["currency", { $fn: "sum", $field: "amount", $as: "total" }],
      sort: { total: -1 },
    });
    const pipeline = buildAggregatePipeline(query);

    expect(pipeline).toContainEqual({ $sort: { total: -1 } });
  });

  it("adds $skip and $limit stages", () => {
    const query = makeQuery({
      groupBy: ["currency"],
      select: ["currency", { $fn: "sum", $field: "amount", $as: "total" }],
      skip: 10,
      limit: 5,
    });
    const pipeline = buildAggregatePipeline(query);

    expect(pipeline).toContainEqual({ $skip: 10 });
    expect(pipeline).toContainEqual({ $limit: 5 });
  });

  it("adds $having as post-project $match", () => {
    const query = makeQuery({
      groupBy: ["currency"],
      select: ["currency", { $fn: "sum", $field: "amount", $as: "total" }],
      having: { total: { $gt: 100 } },
    });
    const pipeline = buildAggregatePipeline(query);

    // $having should appear after $project: $match → $group → $project → $match(having)
    expect(pipeline[3]).toEqual({ $match: { total: { $gt: 100 } } });
  });

  it("$project sets _id: 0", () => {
    const query = makeQuery({
      groupBy: ["status"],
      select: ["status", { $fn: "count", $field: "*", $as: "cnt" }],
    });
    const pipeline = buildAggregatePipeline(query);
    const projectStage = pipeline.find((s: any) => s.$project)!.$project;

    expect(projectStage._id).toBe(0);
  });

  it("handles no $select aggregates (dimensions only)", () => {
    const query = makeQuery({
      groupBy: ["status", "region"],
      select: ["status", "region"],
    });
    const pipeline = buildAggregatePipeline(query);

    expect(pipeline).toEqual([
      { $match: {} },
      { $group: { _id: { status: "$status", region: "$region" } } },
      { $project: { _id: 0, status: "$_id.status", region: "$_id.region" } },
    ]);
  });

  it("resolves alias from $fn_$field when $as is not provided", () => {
    const query = makeQuery({
      groupBy: ["status"],
      select: ["status", { $fn: "sum", $field: "amount" }],
    });
    const pipeline = buildAggregatePipeline(query);
    const groupStage = pipeline.find((s: any) => s.$group)!.$group;
    const projectStage = pipeline.find((s: any) => s.$project)!.$project;

    expect(groupStage).toHaveProperty("sum_amount");
    expect(projectStage).toHaveProperty("sum_amount", 1);
  });

  it("full pipeline with filter + group + having + sort + pagination", () => {
    const query = makeQuery({
      filter: { status: "active" },
      groupBy: ["currency"],
      select: [
        "currency",
        { $fn: "sum", $field: "amount", $as: "total" },
        { $fn: "count", $field: "*", $as: "cnt" },
      ],
      having: { total: { $gt: 100 } },
      sort: { total: -1 },
      limit: 10,
    });
    const pipeline = buildAggregatePipeline(query);

    expect(pipeline).toEqual([
      { $match: { status: "active" } },
      { $group: { _id: { currency: "$currency" }, total: { $sum: "$amount" }, cnt: { $sum: 1 } } },
      { $project: { _id: 0, currency: "$_id.currency", total: 1, cnt: 1 } },
      { $match: { total: { $gt: 100 } } },
      { $sort: { total: -1 } },
      { $limit: 10 },
    ]);
  });
});

describe("buildCountPipeline", () => {
  it("returns group count pipeline", () => {
    const query = makeQuery({
      filter: { status: "active" },
      groupBy: ["currency"],
      count: true,
    });
    const pipeline = buildCountPipeline(query);

    expect(pipeline).toEqual([
      { $match: { status: "active" } },
      { $group: { _id: { currency: "$currency" } } },
      { $count: "count" },
    ]);
  });

  it("passes empty $match when no filter", () => {
    const query = makeQuery({
      groupBy: ["status"],
      count: true,
    });
    const pipeline = buildCountPipeline(query);

    expect(pipeline).toEqual([
      { $match: {} },
      { $group: { _id: { status: "$status" } } },
      { $count: "count" },
    ]);
  });

  it("supports multiple groupBy fields", () => {
    const query = makeQuery({
      groupBy: ["status", "region"],
      count: true,
    });
    const pipeline = buildCountPipeline(query);
    const groupStage = pipeline.find((s: any) => s.$group)!.$group;

    expect(groupStage._id).toEqual({
      status: "$status",
      region: "$region",
    });
  });

  it("applies $having before counting", () => {
    const query = makeQuery({
      groupBy: ["currency"],
      select: ["currency", { $fn: "sum", $field: "amount", $as: "total" }],
      having: { total: { $gt: 100 } },
      count: true,
    });
    const pipeline = buildCountPipeline(query);

    // $group → $project (flatten _id) → $match (having) → $count
    expect(pipeline).toContainEqual({ $match: { total: { $gt: 100 } } });
    // $count must come after $having
    const havingIdx = pipeline.findIndex((s: any) => s.$match?.total);
    const countIdx = pipeline.findIndex((s: any) => s.$count);
    expect(countIdx).toBeGreaterThan(havingIdx);
  });
});
