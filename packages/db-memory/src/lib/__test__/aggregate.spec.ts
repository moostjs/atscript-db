import { DbError, UniquSelect } from "@atscript/db";
import type { AtscriptDbTable, DbControls, DbSpace, TResolvedBucket } from "@atscript/db";
import { BUCKET_UNITS, bucketLabel } from "@uniqu/core";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { MemoryAdapter, setMemoryProvider } from "../memory-adapter";
import { aggregateRows } from "../memory-aggregate";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Populated after fixtures compile.
let AggEvent: any;
let AggPayment: any;

const at = (iso: string) => Date.parse(iso);

/**
 * The seed. Berlin labels (day): #1 2026-03-28 (22:59:59Z = 23:59:59 CET),
 * #2 and #3 2026-03-29 (the spring-forward Sunday), #4 2026-03-30,
 * #5 2027-01-01 (23:30Z on New Year's Eve). `closedAt`: only #2 in range, #3
 * out of range (0), the rest missing.
 */
const SEED = [
  {
    id: 1,
    region: "eu",
    status: "open",
    amount: 10,
    openedAt: at("2026-03-28T22:59:59Z"),
    stats: { source: "web", views: 1 },
  },
  {
    id: 2,
    region: "eu",
    status: "open",
    amount: 20,
    openedAt: at("2026-03-28T23:00:00Z"),
    closedAt: at("2026-03-29T10:00:00Z"),
    stats: { source: "web", views: 2 },
  },
  {
    id: 3,
    region: "us",
    status: "closed",
    amount: 5,
    openedAt: at("2026-03-29T21:59:59Z"),
    closedAt: 0,
    stats: { source: "app", views: 3 },
  },
  { id: 4, region: "us", openedAt: at("2026-03-29T22:00:00Z"), stats: { views: 4 } },
  {
    id: 5,
    region: "eu",
    status: "closed",
    amount: 7,
    openedAt: at("2026-12-31T23:30:00Z"),
    stats: { source: "app", views: 5 },
  },
];

const n = { $fn: "count", $field: "*", $as: "n" };

/**
 * Hour buckets (since 0.1.147): rows per scenario and the expected groups.
 * The label is the local wall-clock hour — a fall-back's repeated hour merges
 * its two UTC hours, a spring-forward's skipped hour never appears, and in
 * +05:30 / +05:45 / −03:30 zones the hour turns at :30 / :15 / :30 UTC.
 */
const HOUR_SCENARIOS: Array<[tz: string, rows: string[], groups: Array<[string, number]>]> = [
  [
    "UTC",
    ["2026-06-14T00:30:00Z", "2026-06-14T01:00:00Z", "2026-06-14T01:59:59.999Z"],
    [
      ["2026-06-14T00", 1],
      ["2026-06-14T01", 2],
    ],
  ],
  // Berlin fall-back 2026-10-25 (01:00Z): 00:30Z = 02:30 CEST, 01:30Z = 02:30 CET
  [
    "Europe/Berlin",
    [
      "2026-10-24T23:30:00Z",
      "2026-10-25T00:30:00Z",
      "2026-10-25T01:30:00Z",
      "2026-10-25T02:30:00Z",
    ],
    [
      ["2026-10-25T01", 1],
      ["2026-10-25T02", 2],
      ["2026-10-25T03", 1],
    ],
  ],
  // Berlin spring-forward 2026-03-29 (01:00Z): 02:00–03:00 local never happens
  [
    "Europe/Berlin",
    ["2026-03-29T00:30:00Z", "2026-03-29T01:30:00Z"],
    [
      ["2026-03-29T01", 1],
      ["2026-03-29T03", 1],
    ],
  ],
  [
    "America/New_York",
    ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z"],
    [
      ["2026-11-01T01", 2],
      ["2026-11-01T02", 1],
    ],
  ],
  [
    "America/New_York",
    ["2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z"],
    [
      ["2026-03-08T01", 1],
      ["2026-03-08T03", 1],
    ],
  ],
  [
    "Asia/Kolkata",
    ["2026-06-14T04:29:59Z", "2026-06-14T04:30:00Z", "2026-06-14T05:29:59Z"],
    [
      ["2026-06-14T09", 1],
      ["2026-06-14T10", 2],
    ],
  ],
  [
    "Asia/Kathmandu",
    ["2026-06-14T04:14:59Z", "2026-06-14T04:15:00Z"],
    [
      ["2026-06-14T09", 1],
      ["2026-06-14T10", 1],
    ],
  ],
  // St. John's −02:30 → −03:30 at 04:30Z on 2026-11-01; −03:30 → −02:30 at 05:30Z on 2026-03-08
  [
    "America/St_Johns",
    ["2026-11-01T03:45:00Z", "2026-11-01T04:45:00Z", "2026-11-01T05:45:00Z"],
    [
      ["2026-11-01T01", 2],
      ["2026-11-01T02", 1],
    ],
  ],
  [
    "America/St_Johns",
    ["2026-03-08T05:15:00Z", "2026-03-08T05:45:00Z"],
    [
      ["2026-03-08T01", 1],
      ["2026-03-08T03", 1],
    ],
  ],
];

/** Sorts result rows by their JSON form — for assertions on unordered groups. */
function bySet(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function expectInvalidQuery(op: Promise<unknown>, message: string): Promise<void> {
  let err: unknown;
  try {
    await op;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(DbError);
  expect((err as DbError).code).toBe("INVALID_QUERY");
  expect((err as DbError).message).toContain(message);
}

describe("MemoryAdapter aggregate (grouping engine)", () => {
  let space: DbSpace;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/agg.as");
    AggEvent = fixtures.AggEvent;
    AggPayment = fixtures.AggPayment;
  });

  beforeEach(async () => {
    space = createTestSpace();
    table = space.getTable(AggEvent) as AtscriptDbTable;
    await table.insertMany(SEED as any);
  });

  const agg = (controls: Record<string, unknown>, filter: Record<string, unknown> = {}) =>
    table.aggregate({ filter, controls } as any);

  // ── accumulators ─────────────────────────────────────────────────────────

  // WHY: a default alias is named after the LOGICAL field even when the
  // field is stored under a @db.column name; $having / $sort use that alias.
  it("names a default alias after the logical field over a @db.column rename", async () => {
    const payments = space.getTable(AggPayment) as AtscriptDbTable;
    await payments.insertMany([
      { id: 1, region: "eu", amount: 10 },
      { id: 2, region: "eu", amount: 20 },
      { id: 3, region: "us", amount: 5 },
      { id: 4, region: "ap", amount: 40 },
    ] as any);
    const rows = await payments.aggregate({
      filter: {},
      controls: {
        $groupBy: ["region"],
        $select: ["region", { $fn: "sum", $field: "amount" }],
        $having: { sum_amount: { $gt: 10 } },
        $sort: { sum_amount: -1 },
      },
    } as any);
    expect(rows).toEqual([
      { region: "ap", sum_amount: 40 },
      { region: "eu", sum_amount: 30 },
    ]);
  });

  // WHY: SQL semantics — count(*) counts rows, count(f) non-null values,
  // sum/avg/min/max skip missing values.
  it("groups by one key with every accumulator", async () => {
    const rows = await agg({
      $groupBy: ["region"],
      $select: [
        "region",
        n,
        { $fn: "count", $field: "amount", $as: "withAmount" },
        { $fn: "sum", $field: "amount", $as: "total" },
        { $fn: "avg", $field: "amount", $as: "mean" },
        { $fn: "min", $field: "amount", $as: "lo" },
        { $fn: "max", $field: "amount", $as: "hi" },
      ],
      $sort: { region: 1 },
    });
    expect(rows).toEqual([
      { region: "eu", n: 3, withAmount: 3, total: 37, mean: 37 / 3, lo: 7, hi: 20 },
      { region: "us", n: 2, withAmount: 1, total: 5, mean: 5, lo: 5, hi: 5 },
    ]);
  });

  // WHY: a group with no numeric value has NULL sum/avg/min/max (SQL), not 0.
  it("sum / avg / min / max are null for a group without values", async () => {
    const rows = await agg(
      {
        $groupBy: ["region"],
        $select: [
          "region",
          { $fn: "count", $field: "amount", $as: "c" },
          { $fn: "sum", $field: "amount", $as: "s" },
          { $fn: "avg", $field: "amount", $as: "a" },
          { $fn: "min", $field: "amount", $as: "lo" },
          { $fn: "max", $field: "amount", $as: "hi" },
        ],
      },
      { id: 4 },
    );
    expect(rows).toEqual([{ region: "us", c: 0, s: null, a: null, lo: null, hi: null }]);
  });

  it("uses the default alias fn_field / count_star", async () => {
    const rows = await agg({
      $groupBy: ["region"],
      $select: ["region", { $fn: "count", $field: "*" }, { $fn: "sum", $field: "amount" }],
      $sort: { region: 1 },
    });
    expect(rows).toEqual([
      { region: "eu", count_star: 3, sum_amount: 37 },
      { region: "us", count_star: 2, sum_amount: 5 },
    ]);
  });

  // WHY: managed views hold no rows on memory, so models declaring computed
  // columns / first-row joins must still sync — both capabilities are
  // accepted like every aggregate function. Since 0.1.147.
  it("accepts every view capability (computed columns, first-row joins)", () => {
    expect([...new MemoryAdapter().viewCapabilities()]).toEqual(["compute", "firstJoin"]);
  });

  // WHY: countDistinct counts distinct NON-NULL values (SQL COUNT(DISTINCT)),
  // null and missing skipped; $having / $sort see the number. Since 0.1.136.
  it("countDistinct counts distinct non-null values; $having / $sort / $count use it", async () => {
    expect(new MemoryAdapter().aggregateFns().has("countDistinct")).toBe(true);
    const select = ["region", { $fn: "countDistinct", $field: "status", $as: "statuses" }];
    expect(await agg({ $groupBy: ["region"], $select: select, $sort: { statuses: -1 } })).toEqual([
      { region: "eu", statuses: 2 },
      { region: "us", statuses: 1 },
    ]);
    const having = { $groupBy: ["region"], $select: select, $having: { statuses: { $gt: 1 } } };
    expect(await agg(having)).toEqual([{ region: "eu", statuses: 2 }]);
    expect(await agg({ ...having, $count: true })).toEqual([{ count: 1 }]);
    expect(
      await agg({
        $groupBy: [],
        $select: [{ $fn: "countDistinct", $field: "stats.source", $as: "sources" }],
      }),
    ).toEqual([{ sources: 2 }]);
  });

  it("rejects an unknown aggregate function with INVALID_QUERY", async () => {
    await expectInvalidQuery(
      agg({ $groupBy: ["region"], $select: ["region", { $fn: "median", $field: "amount" }] }),
      'Unknown aggregate function "median"',
    );
  });

  // ── group keys ───────────────────────────────────────────────────────────

  // WHY: missing groups as null — one null group (SQL), sorted low.
  it("groups a missing key as null", async () => {
    const rows = await agg({
      $groupBy: ["status"],
      $select: ["status", n],
      $sort: { status: 1 },
    });
    expect(rows).toEqual([
      { status: null, n: 1 },
      { status: "closed", n: 2 },
      { status: "open", n: 2 },
    ]);
  });

  // WHY: a dotted group path comes back nested (the Mongo `$project` shape).
  it("groups by a nested path and returns it nested", async () => {
    const rows = await agg({
      $groupBy: ["stats.source"],
      $select: ["stats.source", n],
      $sort: { "stats.source": -1 },
    });
    expect(rows).toEqual([
      { stats: { source: "web" }, n: 2 },
      { stats: { source: "app" }, n: 2 },
      { stats: { source: null }, n: 1 },
    ]);
  });

  it("groups by several keys", async () => {
    const rows = await agg({
      $groupBy: ["region", "status"],
      $select: ["region", "status", n, { $fn: "sum", $field: "amount", $as: "total" }],
    });
    expect(bySet(rows)).toEqual(
      bySet([
        { region: "eu", status: "open", n: 2, total: 30 },
        { region: "eu", status: "closed", n: 1, total: 7 },
        { region: "us", status: "closed", n: 1, total: 5 },
        { region: "us", status: null, n: 1, total: null },
      ]),
    );
  });

  // WHY: the output carries what `$select` asks for, like a SQL SELECT — a
  // group key missing from `$select` still groups (and sorts) but is not returned.
  it("returns only the $select columns", async () => {
    const rows = await agg({
      $groupBy: ["region", "status"],
      $select: ["region", n],
      $sort: { status: 1, region: 1 },
    });
    expect(rows).toEqual([
      { region: "us", n: 1 },
      { region: "eu", n: 1 },
      { region: "us", n: 1 },
      { region: "eu", n: 2 },
    ]);
  });

  it("applies the row filter before grouping", async () => {
    const rows = await agg(
      { $groupBy: ["region"], $select: ["region", n] },
      { amount: { $gte: 7 } },
    );
    expect(rows).toEqual([{ region: "eu", n: 3 }]);
  });

  // ── $having / $sort / pagination / $count ────────────────────────────────

  it("$having filters groups on an aggregate alias and on a group key", async () => {
    expect(
      await agg({ $groupBy: ["region"], $select: ["region", n], $having: { n: { $gt: 2 } } }),
    ).toEqual([{ region: "eu", n: 3 }]);
    expect(
      await agg({
        $groupBy: ["region", "status"],
        $select: ["region", "status", n],
        $having: { $and: [{ region: "eu" }, { n: { $gte: 2 } }] },
      }),
    ).toEqual([{ region: "eu", status: "open", n: 2 }]);
  });

  it("$having reaches a nested group path", async () => {
    const rows = await agg({
      $groupBy: ["stats.source"],
      $select: ["stats.source", n],
      $having: { "stats.source": "app" },
    });
    expect(rows).toEqual([{ stats: { source: "app" }, n: 2 }]);
  });

  // WHY: `$sort` is stable over groups; `$skip` / `$limit` page the sorted groups.
  it("sorts by an aggregate alias and paginates", async () => {
    const controls = {
      $groupBy: ["region", "status"],
      $select: ["region", "status", n],
      $sort: { n: -1, region: 1, status: 1 },
    };
    const all = await agg(controls);
    expect(all).toEqual([
      { region: "eu", status: "open", n: 2 },
      { region: "eu", status: "closed", n: 1 },
      { region: "us", status: null, n: 1 },
      { region: "us", status: "closed", n: 1 },
    ]);
    expect(await agg({ ...controls, $skip: 1, $limit: 2 })).toEqual(all.slice(1, 3));
    expect(await agg({ ...controls, $skip: 3 })).toEqual(all.slice(3));
    expect(await agg({ ...controls, $limit: 1 })).toEqual(all.slice(0, 1));
  });

  // WHY: grouped `$count` counts the groups that survive `$having` — the same
  // population the row query returns.
  it("$count counts groups, after $having", async () => {
    const base = { $groupBy: ["region", "status"], $select: ["region", "status", n] };
    expect(await agg({ ...base, $count: true })).toEqual([{ count: 4 }]);
    expect(await agg({ ...base, $having: { n: { $gt: 1 } }, $count: true })).toEqual([
      { count: 1 },
    ]);
    expect(await agg({ ...base, $count: true }, { region: "nowhere" })).toEqual([{ count: 0 }]);
    expect(await agg(base, { region: "nowhere" })).toEqual([]);
  });

  // ── calendar buckets ─────────────────────────────────────────────────────

  it("advertises every calendar-bucket unit", () => {
    expect([...new MemoryAdapter().calendarBucketUnits()].toSorted()).toEqual(
      ["hour", "day", "month", "quarter", "week", "year"].toSorted(),
    );
  });

  // WHY: the Berlin spring-forward day holds 23:00Z..21:59:59Z; UTC splits differently.
  it("buckets by local day across the DST switch", async () => {
    const day = (tz: string) =>
      agg({
        $groupBy: ["day"],
        $select: [{ $bucket: "day", $field: "openedAt", $tz: tz, $as: "day" }, n],
        $sort: { day: 1 },
      });
    expect(await day("Europe/Berlin")).toEqual([
      { day: "2026-03-28", n: 1 },
      { day: "2026-03-29", n: 2 },
      { day: "2026-03-30", n: 1 },
      { day: "2027-01-01", n: 1 },
    ]);
    expect(await day("UTC")).toEqual([
      { day: "2026-03-28", n: 2 },
      { day: "2026-03-29", n: 2 },
      { day: "2026-12-31", n: 1 },
    ]);
  });

  it("buckets weeks by the requested week start", async () => {
    const week = (weekStart: string) =>
      agg({
        $groupBy: ["week"],
        $select: [
          {
            $bucket: "week",
            $field: "openedAt",
            $tz: "Europe/Berlin",
            $weekStart: weekStart,
            $as: "week",
          },
          n,
        ],
        $sort: { week: 1 },
      });
    expect(await week("mon")).toEqual([
      { week: "2026-03-23", n: 3 },
      { week: "2026-03-30", n: 1 },
      { week: "2026-12-28", n: 1 },
    ]);
    expect(await week("sun")).toEqual([
      { week: "2026-03-22", n: 1 },
      { week: "2026-03-29", n: 3 },
      { week: "2026-12-27", n: 1 },
    ]);
  });

  // WHY: the hour is the zone's wall-clock hour (HOUR_SCENARIOS), not a UTC truncation.
  it("buckets by local wall-clock hour across DST and non-whole-hour offsets", async () => {
    await table.insertMany(
      HOUR_SCENARIOS.flatMap(([, rows], s) =>
        rows.map((iso, i) => ({
          id: 100 + s * 10 + i,
          region: "hour",
          openedAt: at(iso),
          stats: { views: 0 },
        })),
      ) as any,
    );
    for (const [tz, rows, groups] of HOUR_SCENARIOS) {
      const got = await agg(
        {
          $groupBy: ["h"],
          $select: [{ $bucket: "hour", $field: "openedAt", $tz: tz, $as: "h" }, n],
          $sort: { h: 1 },
        },
        { openedAt: { $in: rows.map(at) } },
      );
      expect(got, `${tz} ${rows[0]}`).toEqual(groups.map(([h, count]) => ({ h, n: count })));
    }
  });

  // WHY: every unit × zone must agree with the kernel (the oracle SQLite's UDF runs too).
  it("labels every unit exactly as the kernel does", async () => {
    for (const unit of BUCKET_UNITS) {
      for (const tz of [
        "UTC",
        "Europe/Berlin",
        "America/New_York",
        "America/St_Johns",
        "Asia/Kolkata",
        "Asia/Kathmandu",
      ]) {
        const rows = await agg({
          $groupBy: ["b"],
          $select: [{ $bucket: unit, $field: "openedAt", $tz: tz, $as: "b" }, n],
        });
        const expected = new Map<string, number>();
        for (const row of SEED) {
          const label = bucketLabel(row.openedAt, unit, tz)!;
          expected.set(label, (expected.get(label) ?? 0) + 1);
        }
        expect(bySet(rows)).toEqual(bySet([...expected].map(([b, count]) => ({ b, n: count }))));
      }
    }
  });

  // WHY: a missing source and an out-of-range instant (0) both label null —
  // ONE null group.
  it("puts missing and out-of-range sources into one null bucket", async () => {
    const rows = await agg({
      $groupBy: ["closed"],
      $select: [{ $bucket: "day", $field: "closedAt", $tz: "Europe/Berlin", $as: "closed" }, n],
    });
    expect(bySet(rows)).toEqual(
      bySet([
        { closed: null, n: 4 },
        { closed: "2026-03-29", n: 1 },
      ]),
    );
  });

  it("combines a bucket with a plain key, $having, $sort and $count", async () => {
    const base = {
      $groupBy: ["region", "day"],
      $select: [
        "region",
        { $bucket: "day", $field: "openedAt", $tz: "Europe/Berlin", $as: "day" },
        n,
        { $fn: "sum", $field: "amount", $as: "total" },
      ],
      $having: { day: { $gte: "2026-03-29" } },
    };
    expect(await agg({ ...base, $sort: { day: -1, region: 1 } })).toEqual([
      { region: "eu", day: "2027-01-01", n: 1, total: 7 },
      { region: "us", day: "2026-03-30", n: 1, total: null },
      { region: "eu", day: "2026-03-29", n: 1, total: 20 },
      { region: "us", day: "2026-03-29", n: 1, total: 5 },
    ]);
    expect(await agg({ ...base, $count: true })).toEqual([{ count: 4 }]);
    expect(
      await agg({ ...base, $having: { $and: [base.$having, { region: "us" }] }, $count: true }),
    ).toEqual([{ count: 2 }]);
  });
});

describe("MemoryAdapter aggregate — provider (read-through) mode", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/agg.as");
    AggEvent = fixtures.AggEvent;
  });

  // WHY: aggregation reads the provider snapshot like every other read; a
  // stored null and a missing field are ONE group.
  it("groups provider rows, null and missing together", async () => {
    const space = createTestSpace();
    const source: Array<Record<string, unknown>> = [
      {
        id: 1,
        region: "eu",
        status: null,
        openedAt: at("2026-03-01T00:00:00Z"),
        stats: { views: 1 },
      },
      { id: 2, region: "eu", openedAt: at("2026-03-02T00:00:00Z"), stats: { views: 1 } },
      {
        id: 3,
        region: "eu",
        status: "open",
        openedAt: at("2026-04-02T00:00:00Z"),
        stats: { views: 1 },
      },
    ];
    setMemoryProvider(space, AggEvent, () => source);
    const table = space.getTable(AggEvent) as AtscriptDbTable;

    const byStatus = await table.aggregate({
      filter: {},
      controls: { $groupBy: ["status"], $select: ["status", n], $sort: { status: 1 } },
    } as any);
    expect(byStatus).toEqual([
      { status: null, n: 2 },
      { status: "open", n: 1 },
    ]);

    // Recomputed per read.
    source.push({
      id: 4,
      region: "eu",
      status: "open",
      openedAt: at("2026-04-03T00:00:00Z"),
      stats: { views: 1 },
    });
    const byMonth = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["month"],
        $select: [{ $bucket: "month", $field: "openedAt", $as: "month" }, n],
        $sort: { month: 1 },
      },
    } as any);
    expect(byMonth).toEqual([
      { month: "2026-03-01", n: 2 },
      { month: "2026-04-01", n: 2 },
    ]);
  });
});

/** Adapter-level controls (a `UniquSelect` over physical paths) for {@link aggregateRows}. */
function controls(
  select: unknown[],
  groupBy: string[],
  extra: Record<string, unknown> = {},
  buckets?: TResolvedBucket[],
): DbControls {
  return {
    $select: new UniquSelect(select as any, undefined, buckets),
    $groupBy: groupBy,
    ...extra,
  } as DbControls;
}

describe("aggregateRows (pure engine)", () => {
  // WHY: without `$groupBy` the whole input is one group — even an empty one
  // (SQL's aggregate without GROUP BY always returns a row).
  it("returns one row over the whole input when nothing is grouped", () => {
    const select = [n, { $fn: "sum", $field: "v", $as: "s" }];
    expect(aggregateRows([{ v: 1 }, { v: 2 }], controls(select, []))).toEqual([{ n: 2, s: 3 }]);
    expect(aggregateRows([], controls(select, []))).toEqual([{ n: 0, s: null }]);
  });

  // WHY: group identity is type-tagged (1 ≠ "1", true ≠ "true") and JSON
  // values compare structurally, independent of key order.
  it("keys groups by a canonical, type-aware identity", () => {
    const rows = [
      { k: 1 },
      { k: "1" },
      { k: true },
      { k: "true" },
      { k: { a: 1, b: [2, 3] } },
      { k: { b: [2, 3], a: 1 } },
      { k: -0 },
      { k: 0 },
    ];
    const out = aggregateRows(rows, controls(["k", n], ["k"]));
    expect(out).toEqual([
      { k: 1, n: 1 },
      { k: "1", n: 1 },
      { k: true, n: 1 },
      { k: "true", n: 1 },
      { k: { a: 1, b: [2, 3] }, n: 2 },
      { k: -0, n: 2 },
    ]);
  });

  it("sums numeric strings and bigints, skipping non-numeric values", () => {
    const rows = [{ v: "1.5" }, { v: 2n }, { v: "x" }, { v: true }, { v: null }, { v: 3 }];
    const out = aggregateRows(
      rows,
      controls(
        [
          { $fn: "sum", $field: "v", $as: "s" },
          { $fn: "avg", $field: "v", $as: "a" },
          { $fn: "count", $field: "v", $as: "c" },
        ],
        [],
      ),
    );
    expect(out).toEqual([{ s: 6.5, a: 6.5 / 3, c: 5 }]);
  });

  it("min / max order strings too", () => {
    const out = aggregateRows(
      [{ v: "pear" }, { v: "apple" }, {}, { v: "zucchini" }],
      controls(
        [
          { $fn: "min", $field: "v", $as: "lo" },
          { $fn: "max", $field: "v", $as: "hi" },
        ],
        [],
      ),
    );
    expect(out).toEqual([{ lo: "apple", hi: "zucchini" }]);
  });

  // WHY: distinctness follows group identity — type-tagged, Dates by instant,
  // JSON values structurally; null / undefined are never counted.
  it("countDistinct uses the group identity and skips null / missing", () => {
    const rows = [
      { v: 1 },
      { v: "1" },
      { v: 1 },
      { v: new Date(5) },
      { v: new Date(5) },
      { v: { a: 1, b: 2 } },
      { v: { b: 2, a: 1 } },
      { v: null },
      {},
      // Strings and booleans are their own identity — none collides with a
      // tokenized number / Date / JSON value
      { v: "n1" },
      { v: true },
      { v: true },
      { v: "true" },
      { v: "b1" },
    ];
    const out = aggregateRows(
      rows,
      controls([{ $fn: "countDistinct", $field: "v", $as: "d" }], []),
    );
    expect(out).toEqual([{ d: 8 }]);
    expect(
      aggregateRows([], controls([{ $fn: "countDistinct", $field: "v", $as: "d" }], [])),
    ).toEqual([{ d: 0 }]);
  });

  it("rejects an unknown $fn even over no rows", () => {
    expect(() => aggregateRows([], controls([{ $fn: "median", $field: "v" }], []))).toThrow(
      DbError,
    );
  });

  // WHY: output rows never alias store-owned values.
  it("returns copies of group values", () => {
    const value = { a: 1 };
    const [out] = aggregateRows([{ k: value }], controls(["k"], ["k"]));
    (out!.k as Record<string, unknown>).a = 2;
    expect(value.a).toBe(1);
  });

  it("labels a bucket through the kernel, accepting bigint and rejecting text", () => {
    const bucket = {
      alias: "d",
      field: "t.at",
      unit: "day",
      tz: "UTC",
      weekStart: "mon",
      weekStartIso: 1,
      fd: {} as any,
    } as TResolvedBucket;
    const t = at("2026-05-05T12:00:00Z");
    const out = aggregateRows(
      [{ t: { at: t } }, { t: { at: BigInt(t) } }, { t: { at: "2026-05-05" } }, {}],
      controls([{ $bucket: "day", $field: "t.at", $as: "d" }, n], ["d"], {}, [bucket]),
    );
    expect(out).toEqual([
      { d: "2026-05-05", n: 2 },
      { d: null, n: 2 },
    ]);
  });
});
