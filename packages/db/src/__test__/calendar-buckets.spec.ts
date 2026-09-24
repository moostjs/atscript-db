import { randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll } from "vite-plus/test";
import type { BucketUnit } from "@uniqu/core";
import { BUCKET_UNITS } from "@uniqu/core";

import { DbError } from "../db-error";
import { bucketSourceVerdict, collectQueryPaths } from "../query/query-guards";
import { resolveCalendarBuckets, type TResolvedBucket } from "../query/buckets";
import { UniquSelect } from "../query/uniqu-select";
import { DocumentFieldMapper } from "../strategies/field-mapping";
import { DbSpace } from "../table/db-space";
import type { AtscriptDbTable } from "../table/db-table";
import type { DbQuery, TDbFieldMeta } from "../types";
import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

/**
 * Calendar buckets in the core (since 0.1.132): the shared normalizer
 * (`resolveCalendarBuckets` over uniqu's `resolveBuckets`), the path guard's
 * `bucket` position, strict mode, the adapter capability, and both field
 * mappers handing adapters `controls.$select.buckets` with physical fields.
 */

const KEYS = { k1: randomBytes(32) };
const ALL_UNITS: ReadonlySet<BucketUnit> = new Set(BUCKET_UNITS);

class BucketSqlAdapter extends MockAdapter {
  units: ReadonlySet<BucketUnit> = ALL_UNITS;
  override calendarBucketUnits(): ReadonlySet<BucketUnit> {
    return this.units;
  }
}

class BucketNestedAdapter extends NestedMockAdapter {
  override calendarBucketUnits(): ReadonlySet<BucketUnit> {
    return ALL_UNITS;
  }
  override canFilterField(fd: TDbFieldMeta): boolean {
    return !fd.encrypted;
  }
}

let M: any;

function bind<A extends MockAdapter>(make: () => A, type: "BucketEvent" | "BucketStrict") {
  const adapters: A[] = [];
  const db = new DbSpace(
    () => {
      const a = make();
      adapters.push(a);
      return a;
    },
    { encryption: { defaultKeyId: "k1", keys: KEYS } },
  );
  db.getTable(M.BucketOwner);
  const table = db.getTable(M[type]) as AtscriptDbTable;
  table.getMetadata();
  return { table, adapter: adapters[adapters.length - 1]! };
}

const sql = (type: "BucketEvent" | "BucketStrict" = "BucketEvent") =>
  bind(() => new BucketSqlAdapter(), type);
const nested = () => bind(() => new BucketNestedAdapter(), "BucketEvent");

async function rejection(p: Promise<unknown>): Promise<DbError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(DbError);
    return error as DbError;
  }
  throw new Error("expected a rejection");
}

function sentQuery(adapter: MockAdapter): DbQuery {
  const call = adapter.calls.find((c) => c.method === "aggregate");
  expect(call).toBeDefined();
  return call!.args[0] as DbQuery;
}

const n = { $fn: "count", $field: "*", $as: "n" };
/** A grouped query bucketing `field` by day as `d`. */
const bucketOn = (field: string) => ({
  filter: {},
  controls: { $select: [{ $bucket: "day", $field: field, $as: "d" }, n], $groupBy: ["d"] },
});

beforeAll(async () => {
  await prepareFixtures();
  M = await import("./fixtures/bucket-events.as");
});

describe("resolveCalendarBuckets — the shared normalizer", () => {
  it("normalizes unit, zone, week start and alias (uniqu's rules)", () => {
    const { table } = sql();
    const meta = table.getMetadata();
    const buckets = resolveCalendarBuckets(
      {
        $select: [
          { $bucket: "week", $field: "openedAt", $tz: "europe/berlin", $weekStart: "sun" },
          { $bucket: "day", $field: "closedAt", $as: "closed" },
        ],
        $groupBy: ["week_openedAt", "closed"],
      },
      meta,
    );
    expect(buckets).toEqual([
      {
        alias: "week_openedAt",
        field: "openedAt",
        unit: "week",
        tz: "Europe/Berlin",
        weekStart: "sun",
        weekStartIso: 7,
      },
      {
        alias: "closed",
        field: "closedAt",
        unit: "day",
        tz: "UTC",
        weekStart: "mon",
        weekStartIso: 1,
      },
    ]);
  });

  it("rejects an alias equal to a logical path, a physical column or a navigation field", () => {
    const meta = sql().table.getMetadata();
    for (const alias of ["status", "opened_on", "stats__firstSeenAt", "stats", "owner"]) {
      const run = () =>
        resolveCalendarBuckets(
          {
            $select: [{ $bucket: "day", $field: "openedAt", $as: alias }],
            $groupBy: [alias],
          },
          meta,
        );
      expect(run, alias).toThrow(DbError);
      try {
        run();
      } catch (error) {
        expect((error as DbError).errors).toEqual([
          { path: "$select", message: `Alias "${alias}" collides with field "${alias}"` },
        ]);
      }
    }
  });
});

describe("aggregate() — calendar-bucket validation (every metadata-free rule, core wording)", () => {
  const cases: Array<[string, Record<string, unknown>, { path: string; message: string }]> = [
    [
      "unknown unit",
      { $select: [{ $bucket: "fortnight", $field: "openedAt", $as: "d" }], $groupBy: ["d"] },
      {
        path: "$select",
        message: 'Unknown bucket unit "fortnight" — use day, week, month, quarter or year',
      },
    ],
    [
      "unknown zone",
      {
        $select: [{ $bucket: "day", $field: "openedAt", $tz: "Mars/Olympus", $as: "d" }],
        $groupBy: ["d"],
      },
      { path: "$select", message: 'Unknown time zone "Mars/Olympus"' },
    ],
    [
      "zone alias",
      {
        $select: [{ $bucket: "day", $field: "openedAt", $tz: "US/Eastern", $as: "d" }],
        $groupBy: ["d"],
      },
      {
        path: "$select",
        message: 'Time zone "US/Eastern" is an alias — use "America/New_York"',
      },
    ],
    [
      "week start on a non-week unit",
      {
        $select: [{ $bucket: "day", $field: "openedAt", $weekStart: "sun", $as: "d" }],
        $groupBy: ["d"],
      },
      { path: "$select", message: '$weekStart is only valid with unit "week", not "day"' },
    ],
    [
      "dotted source without $as",
      {
        $select: [{ $bucket: "day", $field: "stats.firstSeenAt" }],
        $groupBy: ["day_stats.firstSeenAt"],
      },
      { path: "$select", message: 'Bucket over "stats.firstSeenAt" needs an explicit $as' },
    ],
    [
      "duplicate alias",
      {
        $select: [
          { $bucket: "day", $field: "openedAt", $as: "d" },
          { ...n, $as: "d" },
        ],
        $groupBy: ["d"],
      },
      { path: "$select", message: 'Duplicate alias "d"' },
    ],
    [
      "bucket not grouped",
      { $select: ["status", { $bucket: "day", $field: "openedAt" }], $groupBy: ["status"] },
      { path: "$select", message: 'Bucket "day_openedAt" in $select must also appear in $groupBy' },
    ],
    [
      "unsupported $select entry",
      { $select: ["status", { $what: 1 }], $groupBy: ["status"] },
      { path: "$select", message: "Unsupported $select entry at index 1" },
    ],
    [
      "non-string $groupBy entry",
      { $select: ["status"], $groupBy: ["status", 7] },
      {
        path: "$groupBy",
        message: "Unsupported $groupBy entry at index 1 — expected a field name or bucket alias",
      },
    ],
  ];
  it.each(cases)("%s", async (_name, controls, issue) => {
    const { table, adapter } = sql();
    const err = await rejection(table.aggregate({ filter: {}, controls } as any));
    expect(err.code).toBe("INVALID_QUERY");
    expect(err.errors[0]).toEqual(issue);
    expect(adapter.calls.some((c) => c.method === "aggregate")).toBe(false);
  });

  it("a bucket in a non-grouped read is rejected, not dropped (findMany / count)", async () => {
    const { table, adapter } = sql();
    const controls = { $select: ["status", { $bucket: "day", $field: "openedAt" }] };
    for (const run of [
      () => table.findMany({ filter: {}, controls } as any),
      () => table.count({ filter: {}, controls } as any),
    ]) {
      const err = await rejection(run());
      expect(err.errors).toEqual([
        { path: "$select", message: "Calendar buckets are only valid in grouped queries" },
      ]);
    }
    expect(adapter.calls.filter((c) => c.method === "findMany")).toHaveLength(0);
  });
});

describe("aggregate() — the bucket source (path guard, strict mode, capability)", () => {
  it("only a number.timestamp leaf can be bucketed", async () => {
    const { table } = sql();
    const points = await rejection(table.aggregate(bucketOn("points") as any));
    expect(points.errors).toEqual([
      {
        path: "points",
        message: 'Cannot bucket "points" — not a timestamp field (declare it number.timestamp)',
      },
    ]);
    const status = await rejection(table.aggregate(bucketOn("status") as any));
    expect(status.errors[0]!.message).toContain("not a timestamp field");
    const unknown = await rejection(table.aggregate(bucketOn("nope") as any));
    expect(unknown.errors).toEqual([{ path: "nope", message: 'Unknown field "nope"' }]);
    const nav = await rejection(table.aggregate(bucketOn("owner.id") as any));
    expect(nav.errors[0]!.message).toBe('Cannot bucket "owner.id" — navigation path');
  });

  it("a timestamp inside a JSON value is rejected on both adapter families", async () => {
    for (const { table } of [sql(), nested()]) {
      const err = await rejection(table.aggregate(bucketOn("meta.seenAt") as any));
      expect(err.errors).toEqual([
        {
          path: "meta.seenAt",
          message: 'Cannot bucket "meta.seenAt" — inside JSON-stored column "meta"',
        },
      ]);
    }
  });

  it("an encrypted source takes the existing ENC_FIELD_AGG path", async () => {
    const { table } = sql();
    const err = await rejection(table.aggregate(bucketOn("secretAt") as any));
    expect(err.code).toBe("ENC_FIELD_AGG");
  });

  it("strict mode: the bucket's source must be a dimension; a bucket is never 'not a measure'", async () => {
    const { table, adapter } = sql("BucketStrict");
    const err = await rejection(table.aggregate(bucketOn("reviewedAt") as any));
    expect(err.code).toBe("INVALID_QUERY");
    expect(err.errors).toEqual([
      { path: "reviewedAt", message: 'Cannot bucket "reviewedAt" — not a dimension' },
    ]);
    // Plain `$groupBy` fields keep the aggregate rule's wording.
    const plain = await rejection(
      table.aggregate({
        filter: {},
        controls: { $select: ["reviewedAt"], $groupBy: ["reviewedAt"] },
      } as any),
    );
    expect(plain.errors).toEqual([
      { path: "$groupBy", message: 'Field "reviewedAt" is not a dimension' },
    ]);
    await table.aggregate({
      filter: {},
      controls: {
        $select: [
          "status",
          { $bucket: "month", $field: "openedAt", $as: "m" },
          { $fn: "sum", $field: "points", $as: "pts" },
        ],
        $groupBy: ["status", "m"],
      },
    } as any);
    expect(sentQuery(adapter).controls.$groupBy).toEqual(["status", "m"]);
  });

  it("BUCKET_NOT_SUPPORTED when the adapter lacks the unit (default: no units)", async () => {
    const plain = bind(() => new MockAdapter(), "BucketEvent");
    const err = await rejection(plain.table.aggregate(bucketOn("openedAt") as any));
    expect(err.code).toBe("BUCKET_NOT_SUPPORTED");
    expect(err.errors).toEqual([
      { path: "openedAt", message: 'Cannot bucket "openedAt" — adapter has no calendar buckets' },
    ]);
    expect(plain.adapter.calls.some((c) => c.method === "aggregate")).toBe(false);

    const partial = sql();
    partial.adapter.units = new Set(["day"]);
    await partial.table.aggregate(bucketOn("openedAt") as any);
    const week = await rejection(
      partial.table.aggregate({
        filter: {},
        controls: { $select: [{ $bucket: "week", $field: "openedAt", $as: "w" }], $groupBy: ["w"] },
      } as any),
    );
    expect(week.code).toBe("BUCKET_NOT_SUPPORTED");
    expect(week.errors).toEqual([
      { path: "$select", message: 'Calendar bucket "week" is not supported by this adapter' },
    ]);
  });
});

function verdictOf(
  bound: { table: AtscriptDbTable; adapter: MockAdapter },
  path: string,
  adapter: Parameters<typeof bucketSourceVerdict>[2] = bound.adapter,
) {
  const meta = bound.table.getMetadata();
  const fd = meta.descriptorByPath.get(path);
  expect(fd, path).toBeDefined();
  return bucketSourceVerdict(fd!, meta, adapter);
}

describe("bucketSourceVerdict — the one bucket-source rule set", () => {
  it("accepts stored timestamp leaves (plain, renamed, flattened / nested)", () => {
    for (const path of ["openedAt", "closedAt", "createdAt", "renamedAt", "stats.firstSeenAt"]) {
      expect(verdictOf(sql(), path), path).toEqual({ ok: true });
      expect(verdictOf(nested(), path), path).toEqual({ ok: true });
    }
  });

  it("names each rejection with a code and the shared reason clause, first failing rule wins", () => {
    const cases: Array<[string, ReturnType<typeof bucketSourceVerdict>]> = [
      [
        "secretAt",
        {
          ok: false,
          code: "encrypted",
          reason: "field is @db.encrypted (ciphertext cannot be compared or ordered)",
        },
      ],
      [
        "points",
        {
          ok: false,
          code: "notTimestamp",
          reason: "not a timestamp field (declare it number.timestamp)",
        },
      ],
    ];
    for (const [path, expected] of cases) {
      expect(verdictOf(sql(), path), path).toEqual(expected);
    }
    // A JSON column is judged by its type before the adapter's storage veto.
    expect(verdictOf(sql(), "meta")).toMatchObject({ ok: false, code: "notTimestamp" });
    // Nested-object adapters keep JSON descendants as leaves — still no source.
    expect(verdictOf(nested(), "meta.seenAt")).toEqual({
      ok: false,
      code: "jsonDescendant",
      reason: 'inside JSON-stored column "meta"',
    });
  });

  it("notFilterable, notDimension and noBuckets", () => {
    const events = sql();
    const blind = { canFilterField: () => false, calendarBucketUnits: () => ALL_UNITS };
    expect(verdictOf(events, "openedAt", blind)).toEqual({
      ok: false,
      code: "notFilterable",
      reason: "adapter cannot filter on this storage type",
    });
    const strict = sql("BucketStrict");
    expect(verdictOf(strict, "reviewedAt")).toEqual({
      ok: false,
      code: "notDimension",
      reason: "not a dimension",
    });
    expect(verdictOf(strict, "openedAt")).toEqual({ ok: true });
    const none = { canFilterField: () => true, calendarBucketUnits: () => new Set<BucketUnit>() };
    expect(verdictOf(events, "openedAt", none)).toEqual({
      ok: false,
      code: "noBuckets",
      reason: "adapter has no calendar buckets",
    });
  });

  it("is exactly what aggregate() enforces for every leaf (parity)", async () => {
    for (const bound of [
      sql(),
      nested(),
      sql("BucketStrict"),
      bind(() => new MockAdapter(), "BucketEvent"),
    ]) {
      const meta = bound.table.getMetadata();
      for (const [path, fd] of meta.descriptorByPath) {
        if (meta.navFields.has(path)) continue;
        const verdict = bucketSourceVerdict(fd, meta, bound.adapter);
        let error: DbError | undefined;
        try {
          await bound.table.aggregate(bucketOn(path) as any);
        } catch (e) {
          error = e as DbError;
        }
        if (verdict.ok) {
          expect(error, path).toBeUndefined();
        } else if (verdict.code === "encrypted") {
          expect(error?.code, path).toBe("ENC_FIELD_AGG");
        } else {
          expect(error?.errors, path).toEqual([
            { path, message: `Cannot bucket "${path}" — ${verdict.reason}` },
          ]);
        }
      }
    }
  });
});

describe("collectQueryPaths — bucket refs", () => {
  it("collects bucket sources, drops bucket aliases from groupBy, exempts them in $sort / $having", () => {
    const refs = collectQueryPaths({
      controls: {
        $select: ["status", { $bucket: "day", $field: "openedAt", $as: "d" }, n],
        $groupBy: ["status", "d"],
        $sort: { d: 1, n: -1, status: 1 },
        $having: { d: { $gte: "2026-03-01" }, n: { $gt: 1 }, status: "open" },
      },
    });
    expect(refs.aggregateMode).toBe(true);
    expect(refs.bucket).toEqual(["openedAt"]);
    expect(refs.groupBy).toEqual(["status"]);
    expect(refs.aggregate).toEqual([]);
    expect(refs.sort).toEqual(["status"]);
    expect(refs.having).toEqual(["status"]);
  });
});

describe("translation — adapters receive physical bucket sources", () => {
  const bucketQuery = (field: string) => ({
    filter: {},
    controls: {
      $select: [
        "status",
        { $bucket: "week", $field: field, $tz: "europe/berlin", $weekStart: "sun", $as: "w" },
        n,
      ],
      $groupBy: ["status", "w"],
      $sort: { w: 1, status: -1 },
      $having: { w: { $gte: "2026-03-01" }, n: { $gt: 0 } },
    },
  });

  it("relational: a renamed and a flattened source map to their columns; aliases pass through", async () => {
    for (const [field, physical] of [
      ["renamedAt", "opened_on"],
      ["stats.firstSeenAt", "stats__firstSeenAt"],
    ] as const) {
      const { table, adapter } = sql();
      adapter.aggregateResult = [{ status: "open", w: "2026-03-22", n: 2 }];
      const rows = await table.aggregate(bucketQuery(field) as any);
      // The label is copied as-is — no formatter ever touches it.
      expect(rows).toEqual([{ status: "open", w: "2026-03-22", n: 2 }]);
      const { controls } = sentQuery(adapter);
      expect(controls.$groupBy).toEqual(["status", "w"]);
      expect(controls.$sort).toEqual({ w: 1, status: -1 });
      expect(controls.$having).toEqual({ w: { $gte: "2026-03-01" }, n: { $gt: 0 } });
      const select = controls.$select!;
      expect(select.asArray).toEqual(["status"]);
      expect(select.aggregates).toEqual([n]);
      const [b] = select.buckets!;
      expect(b).toMatchObject({
        alias: "w",
        field: physical,
        unit: "week",
        tz: "Europe/Berlin",
        weekStart: "sun",
        weekStartIso: 7,
      });
      expect(b!.fd.path).toBe(field);
      expect(b!.fd.physicalName).toBe(physical);
      expect(select.bucketByAlias("w")).toBe(b);
      expect(select.bucketByAlias("status")).toBeUndefined();
    }
  });

  it("document: the source maps through @db.column renames, nested paths stay dotted", async () => {
    for (const [field, physical] of [
      ["renamedAt", "opened_on"],
      ["stats.firstSeenAt", "stats.firstSeenAt"],
    ] as const) {
      const { table, adapter } = nested();
      await table.aggregate(bucketQuery(field) as any);
      const [b] = sentQuery(adapter).controls.$select!.buckets!;
      expect(b!.field).toBe(physical);
      expect(b!.fd.path).toBe(field);
    }
  });
});

describe("DocumentFieldMapper.translateAggregateQuery — @db.column renames (pre-0.1.132 gap)", () => {
  it("maps $groupBy, plain / aggregate $select fields, $sort and $having keys through columnMap", () => {
    const { table } = nested();
    const meta = table.getMetadata();
    const q = new DocumentFieldMapper().translateAggregateQuery(
      {
        filter: { renamedAt: { $gt: 1 } },
        controls: {
          $select: ["renamedAt", { $fn: "max", $field: "renamedAt", $as: "latest" }, n],
          $groupBy: ["renamedAt"],
          $sort: { renamedAt: 1, latest: -1 },
          $having: { renamedAt: { $gt: 5 }, n: { $gt: 1 } },
        },
      } as any,
      meta,
      [],
    );
    expect(q.filter).toEqual({ opened_on: { $gt: 1 } });
    expect(q.controls.$groupBy).toEqual(["opened_on"]);
    expect(q.controls.$select!.asArray).toEqual(["opened_on"]);
    expect(q.controls.$select!.aggregates).toEqual([
      { $fn: "max", $field: "opened_on", $as: "latest" },
      n,
    ]);
    expect(q.controls.$sort).toEqual({ opened_on: 1, latest: -1 });
    expect(q.controls.$having).toEqual({ opened_on: { $gt: 5 }, n: { $gt: 1 } });
  });

  it("a grouped renamed column comes back under its logical name", async () => {
    const { table, adapter } = nested();
    adapter.aggregateResult = [{ opened_on: 1_700_000_000_000, n: 3 }];
    const rows = await table.aggregate({
      filter: {},
      controls: { $select: ["renamedAt", n], $groupBy: ["renamedAt"] },
    } as any);
    expect(sentQuery(adapter).controls.$groupBy).toEqual(["opened_on"]);
    expect(rows).toEqual([{ renamedAt: 1_700_000_000_000, n: 3 }]);
  });
});

describe("UniquSelect — computed entries", () => {
  it("an unknown entry shape is rejected by the normalizer instead of dropped", () => {
    const meta = sql().table.getMetadata();
    for (const bad of [{ $what: 1 }, { $fn: "sum" }, 42, null]) {
      expect(() => resolveCalendarBuckets({ $select: ["status", bad] }, meta)).toThrow(
        expect.objectContaining({
          code: "INVALID_QUERY",
          errors: [{ path: "$select", message: "Unsupported $select entry at index 1" }],
        }),
      );
    }
  });

  it("keeps buckets out of asArray / aggregates; buckets come from the mapper's resolution", () => {
    const raw = ["a", { $bucket: "day", $field: "t", $as: "d" }, n];
    const resolved = [
      { alias: "d", field: "t", unit: "day", tz: "UTC", weekStart: "mon", weekStartIso: 1 },
    ] as unknown as TResolvedBucket[];
    const sel = new UniquSelect(raw as any, undefined, resolved);
    expect(sel.asArray).toEqual(["a"]);
    expect(sel.aggregates).toEqual([n]);
    expect(sel.buckets).toBe(resolved);
    expect(new UniquSelect(["a", n] as any).buckets).toBeUndefined();
    expect(new UniquSelect(raw as any).buckets).toBeUndefined();
  });
});
