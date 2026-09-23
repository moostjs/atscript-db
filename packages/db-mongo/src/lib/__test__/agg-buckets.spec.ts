import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { type DbQuery, type TResolvedBucket, UniquSelect } from "@atscript/db";
import type { BucketUnit, WeekStart } from "@atscript/db/agg";
import { BUCKET_MAX_INSTANT, BUCKET_MIN_INSTANT } from "@uniqu/core";
import { MongoClient, MongoServerError } from "mongodb";

import { buildAggregatePipeline, buildCountPipeline, bucketExpression } from "../../agg";
import { MongoAdapter } from "../mongo-adapter";
import { wrapInvalidQuery } from "../mongo-errors";

// Calendar buckets on MongoDB (design §7.5): the label is the ISO local date of
// the bucket's first day, built from instant → local date conversions only
// (`$dateToString` / `$dateToParts` with `timezone`) plus naive-date
// arithmetic. `$dateTrunc` is never used. Every expression sits behind a
// `$cond` range guard that also folds null / missing sources into one group.

const ISO_WEEKDAY: Record<WeekStart, TResolvedBucket["weekStartIso"]> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
};

function bucket(
  unit: BucketUnit,
  opts: { field?: string; tz?: string; weekStart?: WeekStart; alias?: string } = {},
): TResolvedBucket {
  const weekStart = opts.weekStart ?? "mon";
  const field = opts.field ?? "openedAt";
  return {
    alias: opts.alias ?? `${unit}_${field}`,
    field,
    unit,
    tz: opts.tz ?? "UTC",
    weekStart,
    weekStartIso: ISO_WEEKDAY[weekStart],
    fd: {} as TResolvedBucket["fd"],
  };
}

/** An adapter-level grouped query whose `$select` carries the resolved buckets. */
function query(opts: {
  groupBy: string[];
  select: unknown[];
  buckets: TResolvedBucket[];
  filter?: Record<string, unknown>;
  having?: Record<string, unknown>;
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
  count?: boolean;
}): DbQuery {
  return {
    filter: opts.filter ?? {},
    controls: {
      $groupBy: opts.groupBy,
      $select: new UniquSelect(opts.select as never, undefined, opts.buckets),
      $having: opts.having as never,
      $sort: opts.sort as never,
      $skip: opts.skip,
      $limit: opts.limit,
      $count: opts.count,
    },
  };
}

/** The range guard every bucket expression is wrapped in. */
function guarded(source: string, label: unknown) {
  return {
    $cond: [
      { $and: [{ $gte: [source, 86_400_000] }, { $lt: [source, 32_503_680_000_000] }] },
      label,
      null,
    ],
  };
}

const DATE = { $toDate: { $toLong: "$openedAt" } };
const LOCAL_PARTS = (tz: string) => ({ $dateToParts: { date: DATE, timezone: tz } });

describe("bucketExpression — one literal expression per unit", () => {
  it("guards with uniqu's supported range [BUCKET_MIN_INSTANT, BUCKET_MAX_INSTANT)", () => {
    expect(BUCKET_MIN_INSTANT).toBe(86_400_000);
    expect(BUCKET_MAX_INSTANT).toBe(32_503_680_000_000);
    const expr = bucketExpression(bucket("day"));
    expect(expr.$cond[0]).toEqual({
      $and: [
        { $gte: ["$openedAt", BUCKET_MIN_INSTANT] },
        { $lt: ["$openedAt", BUCKET_MAX_INSTANT] },
      ],
    });
    expect(expr.$cond[2]).toBeNull();
  });

  it("day — $dateToString of the instant in the zone", () => {
    expect(bucketExpression(bucket("day", { tz: "Europe/Berlin" }))).toEqual(
      guarded("$openedAt", {
        $dateToString: { date: DATE, format: "%Y-%m-%d", timezone: "Europe/Berlin" },
      }),
    );
  });

  it("month — local year-month with a literal day 01", () => {
    expect(bucketExpression(bucket("month", { tz: "America/New_York" }))).toEqual(
      guarded("$openedAt", {
        $dateToString: { date: DATE, format: "%Y-%m-01", timezone: "America/New_York" },
      }),
    );
  });

  it("year — local year with a literal 01-01", () => {
    expect(bucketExpression(bucket("year"))).toEqual(
      guarded("$openedAt", {
        $dateToString: { date: DATE, format: "%Y-01-01", timezone: "UTC" },
      }),
    );
  });

  it("quarter — local parts → naive first-of-quarter date → formatted WITHOUT a zone", () => {
    expect(bucketExpression(bucket("quarter", { tz: "Europe/Berlin" }))).toEqual(
      guarded("$openedAt", {
        $let: {
          vars: { p: LOCAL_PARTS("Europe/Berlin") },
          in: {
            $dateToString: {
              date: {
                $dateFromParts: {
                  year: "$$p.year",
                  month: {
                    $subtract: ["$$p.month", { $mod: [{ $subtract: ["$$p.month", 1] }, 3] }],
                  },
                  day: 1,
                },
              },
              format: "%Y-%m-%d",
            },
          },
        },
      }),
    );
  });

  it.each([
    ["mon", 1],
    ["sun", 7],
    ["wed", 3],
  ] as const)(
    "week(%s) — naive local day minus ((isoDow − %i + 7) mod 7) days, formatted WITHOUT a zone",
    (weekStart, iso) => {
      expect(bucketExpression(bucket("week", { tz: "Asia/Kolkata", weekStart }))).toEqual(
        guarded("$openedAt", {
          $let: {
            vars: { p: LOCAL_PARTS("Asia/Kolkata") },
            in: {
              $dateToString: {
                date: {
                  $let: {
                    vars: {
                      n: {
                        $dateFromParts: { year: "$$p.year", month: "$$p.month", day: "$$p.day" },
                      },
                    },
                    in: {
                      $subtract: [
                        "$$n",
                        {
                          $multiply: [
                            {
                              $mod: [
                                { $add: [{ $subtract: [{ $isoDayOfWeek: "$$n" }, iso] }, 7] },
                                7,
                              ],
                            },
                            86_400_000,
                          ],
                        },
                      ],
                    },
                  },
                },
                format: "%Y-%m-%d",
              },
            },
          },
        }),
      );
    },
  );

  it("never uses $dateTrunc and only converts instant → local (a zone only on the instant)", () => {
    for (const unit of ["day", "week", "month", "quarter", "year"] as const) {
      const json = JSON.stringify(bucketExpression(bucket(unit, { tz: "America/Santiago" })));
      expect(json).not.toContain("$dateTrunc");
      // exactly one zone-aware conversion, and it reads the source instant
      expect(json.match(/"timezone"/g)).toHaveLength(1);
      expect(json).toContain('"date":{"$toDate":{"$toLong":"$openedAt"}},');
    }
  });

  it("a dotted document path is read as a dotted field path", () => {
    const expr = bucketExpression(bucket("day", { field: "stats.firstSeenAt", alias: "seen" }));
    expect(expr.$cond[0].$and[0]).toEqual({ $gte: ["$stats.firstSeenAt", BUCKET_MIN_INSTANT] });
    expect(expr.$cond[1].$dateToString.date).toEqual({
      $toDate: { $toLong: "$stats.firstSeenAt" },
    });
  });
});

describe("buildAggregatePipeline — bucket aliases in $groupBy", () => {
  const week = bucket("week", { tz: "Europe/Berlin", weekStart: "sun", alias: "week" });
  const opts = {
    filter: { openedAt: { $gte: 1_772_323_200_000 } },
    groupBy: ["week", "status"],
    select: [
      { $bucket: "week", $field: "openedAt", $tz: "Europe/Berlin", $weekStart: "sun", $as: "week" },
      "status",
      { $fn: "count", $field: "*", $as: "n" },
    ],
    buckets: [week],
  };

  it("keys the bucket positionally in _id and projects it back top-level under its alias", () => {
    expect(buildAggregatePipeline(query(opts))).toEqual([
      { $match: { openedAt: { $gte: 1_772_323_200_000 } } },
      {
        $group: {
          _id: { k0: bucketExpression(week), k1: { $ifNull: ["$status", null] } },
          n: { $sum: 1 },
        },
      },
      { $project: { _id: 0, week: "$_id.k0", status: "$_id.k1", n: 1 } },
    ]);
  });

  it("$having / $sort / $skip / $limit address the alias as a plain top-level field", () => {
    const pipeline = buildAggregatePipeline(
      query({
        ...opts,
        having: { week: { $gte: "2026-03-01" }, n: { $gt: 1 } },
        sort: { week: -1, status: 1 },
        skip: 1,
        limit: 2,
      }),
    );
    expect(pipeline.slice(3)).toEqual([
      { $match: { $and: [{ week: { $gte: "2026-03-01" } }, { n: { $gt: 1 } }] } },
      { $sort: { week: -1, status: 1 } },
      { $skip: 1 },
      { $limit: 2 },
    ]);
  });

  it("a bucket over a dotted source projects back under its (undotted) alias", () => {
    const seen = bucket("month", { field: "stats.firstSeenAt", alias: "seen" });
    const pipeline = buildAggregatePipeline(
      query({
        groupBy: ["metadata.clicks", "seen"],
        select: ["metadata.clicks", { $bucket: "month", $field: "stats.firstSeenAt", $as: "seen" }],
        buckets: [seen],
      }),
    );
    expect(pipeline[1]).toEqual({
      $group: {
        _id: { k0: { $ifNull: ["$metadata.clicks", null] }, k1: bucketExpression(seen) },
      },
    });
    expect(pipeline[2]).toEqual({
      $project: { _id: 0, "metadata.clicks": "$_id.k0", seen: "$_id.k1" },
    });
  });

  it("a positional dotted-path key never collides with a bucket aliased like one", () => {
    const k0 = bucket("day", { alias: "k0" });
    const pipeline = buildAggregatePipeline(
      query({
        groupBy: ["metadata.clicks", "k0"],
        select: ["metadata.clicks", { $bucket: "day", $field: "openedAt", $as: "k0" }],
        buckets: [k0],
      }),
    );
    expect(pipeline[1]).toEqual({
      $group: {
        _id: { k0: { $ifNull: ["$metadata.clicks", null] }, k1: bucketExpression(k0) },
      },
    });
    expect(pipeline[2]).toEqual({
      $project: { _id: 0, "metadata.clicks": "$_id.k0", k0: "$_id.k1" },
    });
  });

  it("two buckets over the same source group independently", () => {
    const day = bucket("day", { alias: "d" });
    const month = bucket("month", { alias: "m" });
    const pipeline = buildAggregatePipeline(
      query({
        groupBy: ["d", "m"],
        select: [
          { $bucket: "day", $field: "openedAt", $as: "d" },
          { $bucket: "month", $field: "openedAt", $as: "m" },
        ],
        buckets: [day, month],
      }),
    );
    expect(pipeline[1]).toEqual({
      $group: { _id: { k0: bucketExpression(day), k1: bucketExpression(month) } },
    });
    expect(pipeline[2]).toEqual({ $project: { _id: 0, d: "$_id.k0", m: "$_id.k1" } });
  });
});

describe("buildCountPipeline — bucket groups", () => {
  const day = bucket("day", { tz: "Europe/Berlin", alias: "day" });
  const select = [
    { $bucket: "day", $field: "openedAt", $tz: "Europe/Berlin", $as: "day" },
    { $fn: "count", $field: "*", $as: "n" },
  ];

  it("without $having: only the bucket dimension in $group._id", () => {
    expect(
      buildCountPipeline(query({ groupBy: ["day"], select, buckets: [day], count: true })),
    ).toEqual([
      { $match: {} },
      { $group: { _id: { k0: bucketExpression(day) } } },
      { $count: "count" },
    ]);
  });

  it("with $having: the same grouped stages as the row pipeline, then $count", () => {
    const opts = {
      groupBy: ["day"],
      select,
      buckets: [day],
      having: { day: { $gte: "2026-03-29" }, n: { $gt: 1 } },
    };
    const count = buildCountPipeline(query({ ...opts, count: true }));
    const rows = buildAggregatePipeline(query({ ...opts, sort: { day: 1 }, limit: 5 }));
    expect(count).toEqual([
      { $match: {} },
      { $group: { _id: { k0: bucketExpression(day) }, n: { $sum: 1 } } },
      { $project: { _id: 0, day: "$_id.k0", n: 1 } },
      { $match: { $and: [{ day: { $gte: "2026-03-29" } }, { n: { $gt: 1 } }] } },
      { $count: "count" },
    ]);
    expect(count.slice(0, -1)).toEqual(rows.slice(0, count.length - 1));
  });
});

// Design §12 Q14 (b): a bare `'$f'` group key puts a missing `f` under `_id: {}`
// and a null one under `_id: { f: null }` — two groups where SQL has one. The
// key is coalesced, so both land in `_id: { f: null }` and project as `f: null`.
describe("plain $groupBy keys coalesce missing → null (one null group)", () => {
  it("plain and dotted keys are grouped as $ifNull, projected back unchanged", () => {
    const pipeline = buildAggregatePipeline({
      filter: {},
      controls: {
        $groupBy: ["region", "metadata.clicks"],
        $select: new UniquSelect(["region", "metadata.clicks"] as never),
      },
    });
    expect(pipeline).toEqual([
      { $match: {} },
      {
        $group: {
          _id: {
            k0: { $ifNull: ["$region", null] },
            k1: { $ifNull: ["$metadata.clicks", null] },
          },
        },
      },
      { $project: { _id: 0, region: "$_id.k0", "metadata.clicks": "$_id.k1" } },
    ]);
  });

  it("the count pipeline groups by the same coalesced keys", () => {
    expect(
      buildCountPipeline({ filter: {}, controls: { $groupBy: ["region"], $count: true } }),
    ).toEqual([
      { $match: {} },
      { $group: { _id: { k0: { $ifNull: ["$region", null] } } } },
      { $count: "count" },
    ]);
  });
});

/** MongoDB's error for an unknown `timezone` (verified on 7.0 and 8.0). */
const unknownZone = () =>
  new MongoServerError({
    message:
      'Failed to optimize pipeline :: caused by :: unrecognized time zone identifier: "Mars/Olympus"',
    code: 40485,
  });

describe("MongoAdapter — calendar bucket capability and time zone errors", () => {
  // Never connects: the collection is mocked (a MongoClient connects lazily).
  const db = new MongoClient("mongodb://127.0.0.1:1").db("buckets");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("declares all five units", () => {
    const adapter = new MongoAdapter(db);
    expect([...adapter.calendarBucketUnits()].toSorted()).toEqual([
      "day",
      "month",
      "quarter",
      "week",
      "year",
    ]);
  });

  it("wrapInvalidQuery maps server code 40485 to BUCKET_TZ_UNAVAILABLE naming the zone", async () => {
    await expect(
      wrapInvalidQuery(async () => {
        throw unknownZone();
      }),
    ).rejects.toMatchObject({
      name: "DbError",
      code: "BUCKET_TZ_UNAVAILABLE",
      errors: [
        {
          path: "$select",
          message:
            'MongoDB does not recognize time zone "Mars/Olympus" — its time zone database may be outdated',
        },
      ],
    });
  });

  it("wrapInvalidQuery rethrows every other error unchanged", async () => {
    const other = new MongoServerError({ message: "boom", code: 2 });
    await expect(
      wrapInvalidQuery(async () => {
        throw other;
      }),
    ).rejects.toBe(other);
  });

  it.each([false, true])(
    "aggregate() maps the error on the row and count paths ($count: %s)",
    async (count) => {
      const adapter = new MongoAdapter(db);
      const aggregate = vi.fn(() => ({
        toArray: async () => {
          throw unknownZone();
        },
      }));
      vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);
      const day = bucket("day", { tz: "Mars/Olympus", alias: "day" });
      await expect(
        adapter.aggregate(
          query({
            groupBy: ["day"],
            select: [{ $bucket: "day", $field: "openedAt", $as: "day" }],
            buckets: [day],
            count,
          }),
        ),
      ).rejects.toMatchObject({ code: "BUCKET_TZ_UNAVAILABLE" });
      expect(aggregate).toHaveBeenCalledOnce();
    },
  );
});
