import { AtscriptDbTable, DbSpace, type DbQuery, UniquSelect } from "@atscript/db";
import type { BucketUnit, WeekStart } from "@atscript/db/agg";
import { bucketLabel } from "@uniqu/core";
import type { Collection, Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Calendar buckets end-to-end on a real MongoDB (mongodb-memory-server): the
// design §11.3 DST fixtures as literals, a per-row sweep against uniqu's kernel
// (the reference semantics every adapter shares), the one-null-group rules and
// the unknown-zone error. Rows are written raw so null vs missing and the
// `@db.column` physical key are exactly what the test says.

const Z = (iso: string) => Date.parse(iso);

let server: any;
let client: MongoClient;
let db: Db;
let raw: Collection;
let table: AtscriptDbTable;

beforeAll(async () => {
  await prepareFixtures();
  const { AggBucketEvent } = await import("./fixtures/agg-buckets.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("buckets");
  table = new DbSpace(() => new MongoAdapter(db, client)).getTable(AggBucketEvent as never);
  raw = db.collection("agg_bucket_events");
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

beforeEach(async () => {
  await raw.deleteMany({});
});

async function seed(docs: Array<Record<string, unknown>>) {
  await raw.insertMany(
    docs.map((d, i) => ({
      id: i + 1,
      status: "open",
      points: 1,
      openedAt: Z("2026-01-01T00:00:00Z"),
      ...d,
    })),
  );
}

type BucketSpec = { unit: BucketUnit; tz?: string; weekStart?: WeekStart; field?: string };

function bucketEntry(b: BucketSpec, alias = "b") {
  return {
    $bucket: b.unit,
    $field: b.field ?? "openedAt",
    ...(b.tz ? { $tz: b.tz } : {}),
    ...(b.weekStart ? { $weekStart: b.weekStart } : {}),
    $as: alias,
  };
}

/** Each row's label: grouped by the unique `id` and the bucket. */
async function labelsById(b: BucketSpec): Promise<Map<number, string | null>> {
  const rows = (await table.aggregate({
    filter: {},
    controls: { $groupBy: ["id", "b"], $select: ["id", bucketEntry(b)] } as never,
  })) as Array<{ id: number; b: string | null }>;
  return new Map(rows.map((r) => [r.id, r.b]));
}

async function counts(b: BucketSpec, extra: Record<string, unknown> = {}) {
  return table.aggregate({
    filter: {},
    controls: {
      $groupBy: ["b"],
      $select: [bucketEntry(b), { $fn: "count", $field: "*", $as: "n" }],
      $sort: { b: 1 },
      ...extra,
    } as never,
  });
}

describe("§11.3 literal DST fixtures", () => {
  const cases: Array<[iso: string, spec: BucketSpec, label: string]> = [
    // Berlin spring-forward (Sunday 2026-03-29, CET→CEST at 01:00Z)
    ["2026-03-28T22:59:59Z", { unit: "day", tz: "Europe/Berlin" }, "2026-03-28"],
    ["2026-03-28T23:00:00Z", { unit: "day", tz: "Europe/Berlin" }, "2026-03-29"],
    ["2026-03-28T23:30:00Z", { unit: "day", tz: "Europe/Berlin" }, "2026-03-29"],
    ["2026-03-29T21:59:59Z", { unit: "day", tz: "Europe/Berlin" }, "2026-03-29"],
    ["2026-03-29T22:00:00Z", { unit: "day", tz: "Europe/Berlin" }, "2026-03-30"],
    ["2026-03-28T23:00:00Z", { unit: "day" }, "2026-03-28"],
    // Berlin fall-back (Sunday 2026-10-25, CEST→CET at 01:00Z)
    ["2026-10-24T21:59:59Z", { unit: "day", tz: "Europe/Berlin" }, "2026-10-24"],
    ["2026-10-24T22:00:00Z", { unit: "day", tz: "Europe/Berlin" }, "2026-10-25"],
    ["2026-10-25T00:30:00Z", { unit: "day", tz: "Europe/Berlin" }, "2026-10-25"],
    ["2026-10-25T01:30:00Z", { unit: "day", tz: "Europe/Berlin" }, "2026-10-25"],
    ["2026-10-25T22:59:59Z", { unit: "day", tz: "Europe/Berlin" }, "2026-10-25"],
    ["2026-10-25T23:00:00Z", { unit: "day", tz: "Europe/Berlin" }, "2026-10-26"],
    // week mon vs sun at a Sunday-00:30-local row
    ["2026-03-28T23:30:00Z", { unit: "week", tz: "Europe/Berlin" }, "2026-03-23"],
    ["2026-03-28T23:30:00Z", { unit: "week", tz: "Europe/Berlin", weekStart: "sun" }, "2026-03-29"],
    ["2026-03-28T23:30:00Z", { unit: "week", weekStart: "sun" }, "2026-03-22"],
    // a week label falls in the previous year
    ["2027-01-01T12:00:00Z", { unit: "week" }, "2026-12-28"],
    // month edges
    ["2026-08-31T22:30:00Z", { unit: "month", tz: "Europe/Berlin" }, "2026-09-01"],
    ["2026-08-31T22:30:00Z", { unit: "month" }, "2026-08-01"],
    ["2026-09-01T02:00:00Z", { unit: "month", tz: "America/New_York" }, "2026-08-01"],
    // year / quarter edges
    ["2026-12-31T23:30:00Z", { unit: "year", tz: "Europe/Berlin" }, "2027-01-01"],
    ["2026-12-31T23:30:00Z", { unit: "quarter", tz: "Europe/Berlin" }, "2027-01-01"],
    ["2026-12-31T23:30:00Z", { unit: "quarter" }, "2026-10-01"],
    // America/Santiago skips local midnight on 2026-09-06: the day starts 01:00 (04:00Z)
    ["2026-09-06T03:59:59Z", { unit: "day", tz: "America/Santiago" }, "2026-09-05"],
    ["2026-09-06T04:00:00Z", { unit: "day", tz: "America/Santiago" }, "2026-09-06"],
    [
      "2026-09-06T04:00:00Z",
      { unit: "week", tz: "America/Santiago", weekStart: "sun" },
      "2026-09-06",
    ],
    // +05:30
    ["2026-03-31T18:30:00Z", { unit: "quarter", tz: "Asia/Kolkata" }, "2026-04-01"],
  ];

  it.each(cases)("%s %o → %s (and the kernel agrees)", async (iso, spec, label) => {
    await seed([{ openedAt: Z(iso) }]);
    expect(bucketLabel(Z(iso), spec.unit, spec.tz, spec.weekStart)).toBe(label);
    expect(await labelsById(spec)).toEqual(new Map([[1, label]]));
  });

  it("the Berlin fall-back day (25 hours) holds all of its rows in one group", async () => {
    const day = ["2026-10-24T22:00:00Z", "2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"];
    await seed(
      [...day, "2026-10-25T22:59:59Z", "2026-10-25T23:00:00Z"].map((iso) => ({ openedAt: Z(iso) })),
    );
    expect(await counts({ unit: "day", tz: "Europe/Berlin" })).toEqual([
      { b: "2026-10-25", n: 4 },
      { b: "2026-10-26", n: 1 },
    ]);
  });
});

// Deterministic instants across the supported range, dense around 2026, for
// zones with DST, half/quarter-hour and 13–14 h offsets and a midnight gap.
describe("per-row sweep against uniqu's kernel", () => {
  const ZONES = [
    "UTC",
    "Europe/Berlin",
    "America/New_York",
    "America/Santiago",
    "America/St_Johns",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Australia/Sydney",
    "Australia/Lord_Howe",
    "Pacific/Chatham",
    "Pacific/Kiritimati",
  ];
  const SPECS: Array<{ unit: BucketUnit; weekStart?: WeekStart }> = [
    { unit: "day" },
    { unit: "month" },
    { unit: "quarter" },
    { unit: "year" },
    ...(["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((weekStart) => ({
      unit: "week" as const,
      weekStart,
    })),
  ];

  const instants: number[] = [];
  // MINSTD Lehmer generator — exact in doubles, so the sweep is reproducible.
  let seedValue = 20_260_923;
  const rand = () => {
    seedValue = (seedValue * 48_271) % 2_147_483_647;
    return seedValue / 2_147_483_647;
  };
  const Y2026 = Z("2026-01-01T00:00:00Z");
  for (let i = 0; i < 120; i++)
    instants.push(Math.floor(86_400_000 + rand() * (Z("2100-01-01T00:00:00Z") - 86_400_000)));
  for (let i = 0; i < 120; i++) instants.push(Math.floor(Y2026 + rand() * 366 * 86_400_000));
  // the range edges
  instants.push(86_400_000, 86_400_001, 32_503_679_999_999);

  it("every zone × unit × week start labels every row like the kernel", async () => {
    await seed(instants.map((openedAt) => ({ openedAt })));
    const mismatches: string[] = [];
    for (const tz of ZONES) {
      for (const spec of SPECS) {
        const got = await labelsById({ ...spec, tz });
        instants.forEach((t, i) => {
          const want = bucketLabel(t, spec.unit, tz, spec.weekStart);
          if (got.get(i + 1) !== want) {
            mismatches.push(
              `${new Date(t).toISOString()} ${tz} ${spec.unit}/${spec.weekStart ?? "-"}: mongo ${got.get(i + 1)} kernel ${want}`,
            );
          }
        });
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);
});

describe("null sources and the supported range", () => {
  it("null, missing, out-of-range and non-numeric sources form ONE null group", async () => {
    const inRange = Z("2026-03-29T10:00:00Z");
    await seed([
      { closedAt: inRange },
      { closedAt: inRange },
      { closedAt: null },
      {}, // missing
      { closedAt: 0 },
      { closedAt: 86_399_999 },
      { closedAt: 32_503_680_000_000 },
      { closedAt: "2026-03-29" },
    ]);
    const rows = await counts({ unit: "day", field: "closedAt" });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { b: null, n: 6 },
        { b: "2026-03-29", n: 2 },
      ]),
    );
    const [{ count }] = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["b"],
        $select: [bucketEntry({ unit: "day", field: "closedAt" })],
        $count: true,
      } as never,
    });
    expect(count).toBe(2);
  });

  it("the range bounds: [1970-01-02Z, 3000-01-01Z)", async () => {
    await seed([
      { openedAt: 86_399_999 },
      { openedAt: 86_400_000 },
      { openedAt: 32_503_679_999_999 },
      { openedAt: 32_503_680_000_000 },
    ]);
    expect(await labelsById({ unit: "day" })).toEqual(
      new Map([
        [1, null],
        [2, "1970-01-02"],
        [3, "2999-12-31"],
        [4, null],
      ]),
    );
  });
});

describe("pipeline composition on the server", () => {
  beforeEach(async () => {
    // Berlin days: 03-28 ×1, 03-29 ×3 (two open, one closed), 03-30 ×1
    await seed([
      { status: "open", points: 1, openedAt: Z("2026-03-28T22:59:59Z") },
      { status: "open", points: 2, openedAt: Z("2026-03-28T23:00:00Z") },
      { status: "open", points: 3, openedAt: Z("2026-03-28T23:30:00Z") },
      { status: "closed", points: 4, openedAt: Z("2026-03-29T21:59:59Z") },
      { status: "open", points: 5, openedAt: Z("2026-03-29T22:00:00Z") },
    ]);
  });
  const DAY = { unit: "day" as const, tz: "Europe/Berlin" };

  it("multi-key group with sum, $having on the alias and an aggregate, $sort/$skip/$limit", async () => {
    const all = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["b", "status"],
        $select: [
          bucketEntry(DAY),
          "status",
          { $fn: "count", $field: "*", $as: "n" },
          { $fn: "sum", $field: "points", $as: "pts" },
        ],
        $sort: { b: 1, status: 1 },
      } as never,
    });
    expect(all).toEqual([
      { b: "2026-03-28", status: "open", n: 1, pts: 1 },
      { b: "2026-03-29", status: "closed", n: 1, pts: 4 },
      { b: "2026-03-29", status: "open", n: 2, pts: 5 },
      { b: "2026-03-30", status: "open", n: 1, pts: 5 },
    ]);

    expect(await counts(DAY, { $having: { b: { $gte: "2026-03-29" }, n: { $gt: 1 } } })).toEqual([
      { b: "2026-03-29", n: 3 },
    ]);
    expect(await counts(DAY, { $sort: { b: -1 }, $skip: 1, $limit: 1 })).toEqual([
      { b: "2026-03-29", n: 3 },
    ]);
    expect(await counts(DAY, { $sort: { n: -1, b: 1 }, $limit: 2 })).toEqual([
      { b: "2026-03-29", n: 3 },
      { b: "2026-03-28", n: 1 },
    ]);
  });

  it("$count with and without $having counts the buckets", async () => {
    const count = (having?: Record<string, unknown>) =>
      table.aggregate({
        filter: {},
        controls: {
          $groupBy: ["b"],
          $select: [bucketEntry(DAY), { $fn: "count", $field: "*", $as: "n" }],
          $having: having,
          $count: true,
        } as never,
      });
    expect(await count()).toEqual([{ count: 3 }]);
    expect(await count({ n: { $gt: 1 } })).toEqual([{ count: 1 }]);
    expect(await count({ b: { $lt: "2026-01-01" } })).toEqual([{ count: 0 }]);
  });

  it("buckets a @db.column-renamed field (physical key) and a nested document path", async () => {
    await raw.updateMany({}, [
      { $set: { opened_on: "$openedAt", stats: { firstSeenAt: "$openedAt" } } },
    ]);
    const expected = [
      { b: "2026-03-28", n: 1 },
      { b: "2026-03-29", n: 3 },
      { b: "2026-03-30", n: 1 },
    ];
    expect(await counts({ ...DAY, field: "renamedAt" })).toEqual(expected);
    expect(await counts({ ...DAY, field: "stats.firstSeenAt" })).toEqual(expected);
  });

  it("the row filter applies before grouping", async () => {
    const rows = await table.aggregate({
      filter: { openedAt: { $gte: Z("2026-03-29T00:00:00Z") } },
      controls: {
        $groupBy: ["b"],
        $select: [bucketEntry(DAY), { $fn: "count", $field: "*", $as: "n" }],
        $sort: { b: 1 },
      } as never,
    });
    expect(rows).toEqual([
      { b: "2026-03-29", n: 1 },
      { b: "2026-03-30", n: 1 },
    ]);
  });
});

describe("unknown time zone on the server", () => {
  it("a zone the server's tz database lacks → BUCKET_TZ_UNAVAILABLE (row and count paths)", async () => {
    await seed([{}]);
    const adapter = new MongoAdapter(db, client);
    // Bypass the core's canonical-name check: the adapter must still turn the
    // server's error into a typed one.
    Object.defineProperty(adapter, "collection", { get: () => raw });
    const b = {
      alias: "b",
      field: "openedAt",
      unit: "day" as const,
      tz: "Mars/Olympus",
      weekStart: "mon" as const,
      weekStartIso: 1 as const,
      fd: {} as never,
    };
    for (const $count of [false, true]) {
      const query: DbQuery = {
        filter: {},
        controls: {
          $groupBy: ["b"],
          $select: new UniquSelect(
            [{ $bucket: "day", $field: "openedAt", $as: "b" }] as never,
            undefined,
            [b],
          ),
          $count,
        },
      };
      await expect(adapter.aggregate(query)).rejects.toMatchObject({
        name: "DbError",
        code: "BUCKET_TZ_UNAVAILABLE",
        errors: [{ path: "$select", message: expect.stringContaining('"Mars/Olympus"') }],
      });
    }
  });
});

// Design §12 Q14 (b): plain `$groupBy` keys — null and missing are ONE group
// (SQL semantics), and the row carries the key as `null`.
describe("plain $groupBy: null and missing form one null group", () => {
  it("top-level key", async () => {
    await seed([{ region: "eu" }, { region: null }, {}, {}]);
    const rows = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["region"],
        $select: ["region", { $fn: "count", $field: "*", $as: "n" }],
      } as never,
    });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { region: "eu", n: 1 },
        { region: null, n: 3 },
      ]),
    );
    expect(
      await table.aggregate({
        filter: {},
        controls: { $groupBy: ["region"], $count: true } as never,
      }),
    ).toEqual([{ count: 2 }]);
    // $having on the null key reaches the coalesced group
    expect(
      await table.aggregate({
        filter: {},
        controls: {
          $groupBy: ["region"],
          $select: ["region", { $fn: "count", $field: "*", $as: "n" }],
          $having: { region: null },
        } as never,
      }),
    ).toEqual([{ region: null, n: 3 }]);
  });

  it("nested key (missing leaf and missing parent)", async () => {
    await seed([{ meta: { tier: "gold" } }, { meta: { tier: null } }, { meta: {} }, {}]);
    const rows = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["meta.tier"],
        $select: ["meta.tier", { $fn: "count", $field: "*", $as: "n" }],
      } as never,
    });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { meta: { tier: "gold" }, n: 1 },
        { meta: { tier: null }, n: 3 },
      ]),
    );
  });
});
