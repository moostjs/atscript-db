import { describe, it, expect } from "vite-plus/test";
import { type DbQuery, UniquSelect } from "@atscript/db";

import { aggregateOptions, buildAggregatePipeline } from "../../agg";
import { hasNullsPlacement, NULLS_FLAG_PREFIX, rowOrderStages, sortStages } from "../mongo-sort";

// Pipeline shapes of NULL placement in sort (`$nulls`, since 0.1.153): a flag
// per placed key before the `$sort`, ordered right before its key, dropped
// after `$skip` / `$limit`. An unplaced `$sort` is exactly `{ $sort }`.

const F0 = `${NULLS_FLAG_PREFIX}0`;
const F1 = `${NULLS_FLAG_PREFIX}1`;
const isNull = (path: string) => ({ $lte: [path, null] });

describe("sortStages", () => {
  it("no $sort → no stage; no placement → the plain $sort", () => {
    expect(sortStages(undefined)).toEqual({ stages: [] });
    expect(sortStages({ $nulls: { a: "last" } })).toEqual({ stages: [] });
    const sort = { a: 1, id: -1 };
    expect(sortStages({ $sort: sort })).toEqual({ stages: [{ $sort: sort }] });
    // entries for keys that are not sorted by, or not a placement, change nothing
    expect(sortStages({ $sort: sort, $nulls: { b: "first", a: "nope" } })).toEqual({
      stages: [{ $sort: sort }],
    });
    expect(hasNullsPlacement({ $sort: sort, $nulls: { b: "first" } })).toBe(false);
    expect(hasNullsPlacement({ $sort: sort, $nulls: {} })).toBe(false);
    expect(hasNullsPlacement({ $sort: sort, $nulls: { a: "last" } })).toBe(true);
    // a placement equal to BSON order (null smallest) keeps the plain, index-served sort
    expect(hasNullsPlacement({ $sort: sort, $nulls: { a: "first", id: "last" } })).toBe(false);
    expect(sortStages({ $sort: sort, $nulls: { a: "first" } })).toEqual({
      stages: [{ $sort: sort }],
    });
  });

  it("first → flag descending, last → flag ascending, each right before its key", () => {
    const { stages, cleanup } = sortStages({
      $sort: { a: -1, "b.c": 1, d: 1, id: 1 },
      $nulls: { a: "first", "b.c": "last", d: "first" },
    });
    expect(stages).toEqual([
      { $addFields: { [F0]: isNull("$a"), [F1]: isNull("$b.c") } },
      { $sort: { [F0]: -1, a: -1, [F1]: 1, "b.c": 1, d: 1, id: 1 } },
    ]);
    expect(Object.keys(stages[1]!.$sort)).toEqual([F0, "a", F1, "b.c", "d", "id"]);
    expect(cleanup).toEqual({ $project: { [F0]: 0, [F1]: 0 } });
  });

  it("rowOrderStages renders TRowOrderKey[] with their nulls", () => {
    expect(
      rowOrderStages([
        { column: "x", desc: true, nulls: "first" },
        { column: "_id", desc: false },
      ]),
    ).toEqual([{ $addFields: { [F0]: isNull("$x") } }, { $sort: { [F0]: -1, x: -1, _id: 1 } }]);
    expect(rowOrderStages([{ column: "x", desc: false }])).toEqual([{ $sort: { x: 1 } }]);
  });
});

const groupedQuery = (
  select: unknown[],
  computed: ConstructorParameters<typeof UniquSelect>[3],
  extra: Record<string, unknown> = {},
): DbQuery =>
  ({
    filter: {},
    controls: {
      $groupBy: ["grp"],
      $select: new UniquSelect(select as never, undefined, undefined, computed),
      ...extra,
    },
  }) as DbQuery;

describe("grouped aggregate pipeline", () => {
  it("$sort with $nulls: flags after $group / $project, dropped after $skip / $limit", () => {
    const pipeline = buildAggregatePipeline(
      groupedQuery(
        ["grp", { $fn: "max", $field: "v", $as: "mx" }],
        {},
        {
          $sort: { mx: 1, grp: -1 },
          $nulls: { mx: "last" },
          $skip: 1,
          $limit: 2,
        },
      ),
    );
    expect(pipeline.map((s) => Object.keys(s)[0])).toEqual([
      "$match",
      "$group",
      "$project",
      "$addFields",
      "$sort",
      "$skip",
      "$limit",
      "$project",
    ]);
    expect(pipeline[4]).toEqual({ $sort: { [F0]: 1, mx: 1, grp: -1 } });
    expect(pipeline[7]).toEqual({ $project: { [F0]: 0 } });
  });

  it("first / last: the placed row order sorts before $group (allowDiskUse kept)", () => {
    const pipeline = buildAggregatePipeline(
      groupedQuery(["grp", { $fn: "last", $field: "title", $as: "t" }], {
        rowOrder: [
          { column: "at", desc: false, nulls: "last" },
          { column: "_id", desc: false },
        ],
      }),
    );
    expect(pipeline.map((s) => Object.keys(s)[0])).toEqual([
      "$match",
      "$addFields",
      "$sort",
      "$group",
      "$project",
    ]);
    expect(pipeline[2]).toEqual({ $sort: { [F0]: 1, at: 1, _id: 1 } });
    expect(aggregateOptions(pipeline)).toEqual({ allowDiskUse: true });
  });
});
