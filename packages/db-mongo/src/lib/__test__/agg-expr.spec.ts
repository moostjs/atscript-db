import { describe, it, expect } from "vite-plus/test";
import { type DbQuery, UniquSelect } from "@atscript/db";

import {
  aggregateOptions,
  buildAggregatePipeline,
  buildCountPipeline,
  emptyGroupRow,
} from "../../agg";

// Pipeline shapes of query-time arithmetic and first / last on MongoDB
// (since 0.1.148): `$sort` + `$first` / `$last` before / inside `$group`,
// per-row expressions as accumulator operands, group-level expressions as
// `$addFields` stages in dependency order.

const f = (field: string) => ({ field });

function query(
  select: unknown[],
  computed: ConstructorParameters<typeof UniquSelect>[3],
  extra: Record<string, unknown> = {},
): DbQuery {
  return {
    filter: {},
    controls: {
      $groupBy: ["ticketId"],
      $select: new UniquSelect(select as never, undefined, undefined, computed),
      ...extra,
    },
  } as DbQuery;
}

describe("row-level expression aggregates", () => {
  it("accumulate the double-cast expression; NULL / ÷0 propagate through $cond", () => {
    const pipeline = buildAggregatePipeline(
      query(["ticketId"], {
        exprAggregates: [
          {
            fn: "sum",
            alias: "rev",
            expr: { op: "*", args: [f("price"), f("qty")] } as never,
            names: ["price", "qty"],
          },
          {
            fn: "max",
            alias: "ratio",
            expr: { op: "/", args: [f("price"), f("est_points")] } as never,
            names: ["price", "est_points"],
          },
        ],
      }),
    );
    const group = pipeline.find((s) => "$group" in s)!.$group;
    expect(group.rev).toEqual({
      $sum: { $multiply: [{ $toDouble: "$price" }, { $toDouble: "$qty" }] },
    });
    expect(group.ratio).toEqual({
      $max: {
        $cond: [
          { $eq: [{ $toDouble: "$est_points" }, 0] },
          null,
          { $divide: [{ $toDouble: "$price" }, { $toDouble: "$est_points" }] },
        ],
      },
    });
    const project = pipeline.find((s) => "$project" in s)!.$project;
    // a sum over no non-null result is null (SQL), not MongoDB's 0
    expect(group.__as_n_rev).toEqual({
      $sum: {
        $cond: [
          { $gt: [{ $multiply: [{ $toDouble: "$price" }, { $toDouble: "$qty" }] }, null] },
          1,
          0,
        ],
      },
    });
    expect(project.rev).toEqual({ $cond: [{ $eq: ["$__as_n_rev", 0] }, null, "$rev"] });
    expect(project.ratio).toBe(1);
    expect(group).not.toHaveProperty("__as_n_ratio");
  });

  it("a plain sum projects null over no non-null value; avg / min / max need no counter", () => {
    const pipeline = buildAggregatePipeline(
      query(
        [
          "ticketId",
          { $fn: "sum", $field: "est_points", $as: "est" },
          { $fn: "avg", $field: "est_points", $as: "mean" },
        ],
        {},
      ),
    );
    const group = pipeline.find((s) => "$group" in s)!.$group;
    expect(group.__as_n_est).toEqual({ $sum: { $cond: [{ $gt: ["$est_points", null] }, 1, 0] } });
    expect(group).not.toHaveProperty("__as_n_mean");
    const project = pipeline.find((s) => "$project" in s)!.$project;
    expect(project.est).toEqual({ $cond: [{ $eq: ["$__as_n_est", 0] }, null, "$est"] });
    expect(project.mean).toBe(1);
  });
});

describe("group-level expressions", () => {
  const select = [
    "ticketId",
    { $fn: "count", $field: "*", $as: "open" },
    { $fn: "sum", $field: "est_points", $as: "est" },
  ];
  const computed = {
    exprs: [
      {
        alias: "avgEst",
        expr: { op: "/", args: [f("est"), f("open")] } as never,
        names: ["est", "open"],
      },
      { alias: "rank", expr: { op: "+", args: [f("avgEst"), 1] } as never, names: ["avgEst"] },
    ],
  };

  it("adds one $addFields per expression after $project, before $match($having) and $sort", () => {
    const pipeline = buildAggregatePipeline(
      query(select, computed, { $having: { rank: { $gte: 2 } }, $sort: { rank: -1 } }),
    );
    expect(pipeline.map((s) => Object.keys(s)[0])).toEqual([
      "$match",
      "$group",
      "$project",
      "$addFields",
      "$addFields",
      "$match",
      "$sort",
    ]);
    const fields = pipeline.filter((s) => "$addFields" in s).map((s) => s.$addFields);
    expect(fields[0]).toEqual({
      avgEst: {
        $cond: [
          { $eq: [{ $toDouble: "$open" }, 0] },
          null,
          { $divide: [{ $toDouble: "$est" }, { $toDouble: "$open" }] },
        ],
      },
    });
    // a later expression reads the earlier one's field
    expect(fields[1]).toEqual({ rank: { $add: [{ $toDouble: "$avgEst" }, { $toDouble: 1 }] } });
  });

  it("the count pipeline runs the same stages when a $having needs them", () => {
    const pipeline = buildCountPipeline(
      query(select, computed, { $having: { rank: { $gte: 2 } } }),
    );
    expect(pipeline.map((s) => Object.keys(s)[0])).toEqual([
      "$match",
      "$group",
      "$project",
      "$addFields",
      "$addFields",
      "$match",
      "$count",
    ]);
  });
});

describe("first / last", () => {
  const select = [
    "ticketId",
    { $fn: "first", $field: "raisedAt", $as: "oldestAt" },
    { $fn: "last", $field: "title", $as: "newestTitle" },
  ];
  const computed = {
    rowOrder: [
      { column: "raisedAt", desc: false },
      { column: "severity", desc: true },
      { column: "_id", desc: false },
    ],
  };

  it("sorts the rows by $rowOrder (primary key last) before $group and takes $first / $last", () => {
    const pipeline = buildAggregatePipeline(query(select, computed));
    expect(pipeline.map((s) => Object.keys(s)[0])).toEqual([
      "$match",
      "$sort",
      "$group",
      "$project",
    ]);
    expect(pipeline[1]).toEqual({ $sort: { raisedAt: 1, severity: -1, _id: 1 } });
    const group = pipeline.find((s) => "$group" in s)!.$group;
    expect(group.oldestAt).toEqual({ $first: { $ifNull: ["$raisedAt", null] } });
    expect(group.newestTitle).toEqual({ $last: { $ifNull: ["$title", null] } });
    expect(pipeline.find((s) => "$project" in s)!.$project).toMatchObject({
      oldestAt: 1,
      newestTitle: 1,
    });
  });

  it("a plain count-only pipeline needs no ordering", () => {
    const pipeline = buildCountPipeline(query(select, computed));
    expect(pipeline.map((s) => Object.keys(s)[0])).toEqual(["$match", "$group", "$count"]);
  });
});

describe("allowDiskUse", () => {
  const select = ["ticketId", { $fn: "first", $field: "title", $as: "t" }];
  const computed = { rowOrder: [{ column: "_id", desc: false }] };

  it("is set only for a pipeline that sorts before it groups", () => {
    expect(aggregateOptions(buildAggregatePipeline(query(select, computed)))).toEqual({
      allowDiskUse: true,
    });
    // a $sort AFTER the $group (the result's) does not count
    expect(
      aggregateOptions(
        buildAggregatePipeline(
          query(["ticketId", { $fn: "count", $field: "*", $as: "n" }], {}, { $sort: { n: 1 } }),
        ),
      ),
    ).toBeUndefined();
  });

  it("a count without $having builds no ordering, so no disk use", () => {
    expect(aggregateOptions(buildCountPipeline(query(select, computed)))).toBeUndefined();
  });
});

describe("emptyGroupRow — an ungrouped aggregate over no rows is one group", () => {
  const ungrouped = (
    select: unknown[],
    computed: ConstructorParameters<typeof UniquSelect>[3],
    extra = {},
  ) => query(select, computed, { $groupBy: [], ...extra });

  it("counts 0, everything else null, expressions evaluated over those", () => {
    const row = emptyGroupRow(
      ungrouped(
        [
          { $fn: "count", $field: "*", $as: "n" },
          { $fn: "countDistinct", $field: "title", $as: "d" },
          { $fn: "sum", $field: "est_points", $as: "est" },
          { $fn: "first", $field: "title", $as: "t" },
        ],
        {
          exprAggregates: [
            { fn: "sum", alias: "rev", expr: f("price") as never, names: ["price"] },
          ],
          exprs: [{ alias: "n1", expr: { op: "+", args: [f("n"), 1] } as never, names: ["n"] }],
          rowOrder: [{ column: "_id", desc: false }],
        },
      ),
    );
    expect(row).toEqual({ n: 0, d: 0, est: null, rev: null, t: null, n1: 1 });
  });

  it("is undefined for a grouped query, a $having, a $skip, or nothing computed", () => {
    const select = [{ $fn: "count", $field: "*", $as: "n" }];
    expect(emptyGroupRow(query(select, {}))).toBeUndefined();
    expect(emptyGroupRow(ungrouped(select, {}, { $having: { n: { $gt: 0 } } }))).toBeUndefined();
    expect(emptyGroupRow(ungrouped(select, {}, { $skip: 1 }))).toBeUndefined();
    expect(emptyGroupRow(ungrouped([], {}))).toBeUndefined();
  });
});
