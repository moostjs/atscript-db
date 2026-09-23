import Database from "better-sqlite3";
import { AtscriptDbTable, DbError, UniquSelect } from "@atscript/db";
import type { DbControls, TResolvedBucket } from "@atscript/db";
import { bucketLabel } from "@uniqu/core";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";

import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { SQLITE_BUCKET_FN, atscriptBucketUdf, sqliteCalendarBucket } from "../calendar-bucket";
import { buildAggregateCount, buildAggregateSelect } from "../sql-builder";
import { SqliteAdapter } from "../sqlite-adapter";
import { prepareFixtures, RecordingDriver } from "./test-utils";

let BucketEvent: any;

const at = (iso: string) => Date.parse(iso);

/**
 * Berlin day labels: #1 2026-03-28 (22:59:59Z = 23:59:59 CET), #2 and #3
 * 2026-03-29 (the spring-forward Sunday), #4 2026-03-30, #5 2027-01-01
 * (23:30Z on New Year's Eve). `closedAt`: #2 in range, #3 out of range (0),
 * the rest NULL.
 */
const SEED = [
  { id: 1, region: "eu", amount: 10, openedAt: at("2026-03-28T22:59:59Z") },
  {
    id: 2,
    region: "eu",
    amount: 20,
    openedAt: at("2026-03-28T23:00:00Z"),
    closedAt: at("2026-03-29T10:00:00Z"),
  },
  { id: 3, region: "us", amount: 5, openedAt: at("2026-03-29T21:59:59Z"), closedAt: 0 },
  { id: 4, region: "us", openedAt: at("2026-03-29T22:00:00Z") },
  { id: 5, region: "eu", amount: 7, openedAt: at("2026-12-31T23:30:00Z") },
];

const n = { $fn: "count", $field: "*", $as: "n" };

function bySet(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function bucket(over: Partial<TResolvedBucket> = {}): TResolvedBucket {
  return {
    alias: "week",
    field: "openedAt",
    unit: "week",
    tz: "Europe/Berlin",
    weekStart: "sun",
    weekStartIso: 7,
    fd: {} as any,
    ...over,
  } as TResolvedBucket;
}

/** The shared aggregate builder over the SQLite dialect, grouping by one bucket. */
function buildWithBucket(b: TResolvedBucket) {
  return buildAggregateSelect("t", { sql: "1=1", params: [] }, {
    $select: new UniquSelect([{ $bucket: b.unit, $field: "c" }] as any, undefined, [b]),
    $groupBy: [b.alias],
  } as unknown as DbControls);
}

/** A driver that counts `registerFunction` calls and forwards them. */
class CountingDriver extends RecordingDriver {
  registrations: string[] = [];
  registerFunction(
    name: string,
    fn: (...args: any[]) => unknown,
    opts?: { deterministic?: boolean },
  ): void {
    this.registrations.push(name);
    this.inner.registerFunction(name, fn, opts);
  }
}

describe("SQLite calendar buckets", () => {
  beforeAll(async () => {
    await prepareFixtures();
    BucketEvent = (await import("./fixtures/buckets.as")).BucketEvent;
  });

  // ── rendering ────────────────────────────────────────────────────────────

  describe("dialect rendering", () => {
    it("renders the UDF call with inlined literals", () => {
      expect(sqliteCalendarBucket('"openedAt"', bucket())).toBe(
        `atscript_bucket("openedAt", 'week', 'Europe/Berlin', 'sun')`,
      );
      expect(
        sqliteCalendarBucket('"closedAt"', bucket({ unit: "month", tz: "UTC", weekStart: "mon" })),
      ).toBe(`atscript_bucket("closedAt", 'month', 'UTC', 'mon')`);
    });

    // WHY: the expression is inlined, so every argument is re-checked (the
    // shared builder asserts the closed sets, the dialect the zone charset).
    it("rejects a value outside the closed sets / zone charset", () => {
      expect(() => buildWithBucket(bucket({ unit: "hour" as any }))).toThrow(DbError);
      expect(() => buildWithBucket(bucket({ weekStart: "x'" as any }))).toThrow(DbError);
      expect(() => buildWithBucket(bucket({ tz: "UTC'; DROP TABLE x;--" }))).toThrow(DbError);
      expect(() => sqliteCalendarBucket('"c"', bucket({ tz: "UTC'; DROP TABLE x;--" }))).toThrow(
        DbError,
      );
    });

    // WHY: parameter-free — SELECT / GROUP BY / HAVING render the expression,
    // ORDER BY the alias, and the bind parameters are those of the same query
    // without a bucket.
    it("renders SELECT / GROUP BY / HAVING / count with the expression, ORDER BY with the alias", () => {
      const b = bucket();
      const expr = `atscript_bucket("openedAt", 'week', 'Europe/Berlin', 'sun')`;
      const where = { sql: `"region" = ?`, params: ["eu"] };
      const controls = {
        $select: new UniquSelect(
          [{ $bucket: "week", $field: "openedAt" } as any, n as any],
          undefined,
          [b],
        ),
        $groupBy: ["week"],
        $having: { week: { $gte: "2026-03-01" } },
        $sort: { week: -1 },
        $limit: 10,
      } as unknown as DbControls;
      const { sql, params } = buildAggregateSelect("bucket_events", where, controls);
      expect(sql).toBe(
        `SELECT ${expr} AS "week", COUNT(*) AS "n" FROM "bucket_events" WHERE "region" = ?` +
          ` GROUP BY ${expr} HAVING ${expr} >= ? ORDER BY "week" DESC LIMIT ?`,
      );
      expect(params).toEqual(["eu", "2026-03-01", 10]);

      const count = buildAggregateCount("bucket_events", where, {
        ...controls,
        $count: true,
      } as DbControls);
      expect(count.sql).toContain(`GROUP BY ${expr} HAVING ${expr} >= ?`);
      expect(count.params).toEqual(["eu", "2026-03-01"]);
    });
  });

  // ── the UDF ──────────────────────────────────────────────────────────────

  describe("atscript_bucket UDF", () => {
    it("labels numbers and bigints with the kernel; NULL / TEXT / BLOB / out of range → null", () => {
      const t = at("2026-03-29T12:34:56.789Z");
      expect(atscriptBucketUdf(t, "week", "Europe/Berlin", "sun")).toBe("2026-03-29");
      expect(atscriptBucketUdf(BigInt(t - 789), "month", "UTC", "mon")).toBe("2026-03-01");
      expect(atscriptBucketUdf(t + 0.5, "day", "Asia/Kolkata", "mon")).toBe(
        bucketLabel(t, "day", "Asia/Kolkata"),
      );
      expect(atscriptBucketUdf(null, "day", "UTC", "mon")).toBeNull();
      expect(atscriptBucketUdf("2026-03-29", "day", "UTC", "mon")).toBeNull();
      expect(atscriptBucketUdf(Buffer.from([1]), "day", "UTC", "mon")).toBeNull();
      expect(atscriptBucketUdf(0, "day", "UTC", "mon")).toBeNull();
      expect(atscriptBucketUdf(32_503_680_000_000, "day", "UTC", "mon")).toBeNull();
    });

    it("declares four parameters (drivers read the arity from fn.length)", () => {
      expect(atscriptBucketUdf.length).toBe(4);
    });

    // WHY: better-sqlite3's safe-integer mode hands INTEGERs over as bigint.
    it("runs on a safe-integer connection", () => {
      const db = new Database(":memory:");
      db.defaultSafeIntegers(true);
      const driver = new BetterSqlite3Driver(db);
      new SqliteAdapter(driver);
      const row = driver.get<{ d: string }>(
        `SELECT ${SQLITE_BUCKET_FN}(?, 'year', 'Europe/Berlin', 'mon') AS d`,
        [BigInt(at("2026-12-31T23:30:00Z"))],
      );
      expect(row?.d).toBe("2027-01-01");
      driver.close();
    });
  });

  // ── registration + capability ────────────────────────────────────────────

  describe("registration", () => {
    it("registers the UDF once per shared driver", () => {
      const driver = new CountingDriver(new BetterSqlite3Driver(":memory:"));
      const adapters = [
        new SqliteAdapter(driver),
        new SqliteAdapter(driver),
        new SqliteAdapter(driver),
      ];
      expect(driver.registrations).toEqual([SQLITE_BUCKET_FN]);
      for (const adapter of adapters) {
        expect([...adapter.calendarBucketUnits()].toSorted()).toEqual([
          "day",
          "month",
          "quarter",
          "week",
          "year",
        ]);
      }
      driver.close();
    });

    // WHY: a custom driver without the hook cannot run the UDF — the core
    // answers BUCKET_NOT_SUPPORTED (a clean 400) instead of an engine error.
    it("a driver without registerFunction has no bucket units → BUCKET_NOT_SUPPORTED", async () => {
      const driver = new RecordingDriver(new BetterSqlite3Driver(":memory:"));
      const adapter = new SqliteAdapter(driver);
      expect(adapter.calendarBucketUnits().size).toBe(0);
      const table = new AtscriptDbTable(BucketEvent, adapter);
      await table.ensureTable();
      await table.insertOne(SEED[0] as any);

      let err: unknown;
      try {
        await table.aggregate({
          filter: {},
          controls: {
            $groupBy: ["day"],
            $select: [{ $bucket: "day", $field: "openedAt", $as: "day" }, n],
          },
        } as any);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DbError);
      expect((err as DbError).code).toBe("BUCKET_NOT_SUPPORTED");
      // Plain grouping still works on that driver.
      expect(
        await table.aggregate({
          filter: {},
          controls: { $groupBy: ["region"], $select: ["region", n] },
        } as any),
      ).toEqual([{ region: "eu", n: 1 }]);
      driver.close();
    });
  });

  // ── end to end ───────────────────────────────────────────────────────────

  describe("aggregate", () => {
    let driver: BetterSqlite3Driver;
    let table: AtscriptDbTable;

    beforeEach(async () => {
      driver = new BetterSqlite3Driver(":memory:");
      table = new AtscriptDbTable(BucketEvent, new SqliteAdapter(driver));
      await table.ensureTable();
      await table.insertMany(SEED as any);
    });

    afterEach(() => {
      driver.close();
    });

    const agg = (controls: Record<string, unknown>, filter: Record<string, unknown> = {}) =>
      table.aggregate({ filter, controls } as any);

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

    it("labels every unit exactly as the kernel does", async () => {
      for (const unit of ["day", "week", "month", "quarter", "year"] as const) {
        for (const tz of ["UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata"]) {
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

    // WHY: NULL and an out-of-range instant (0) both label NULL — ONE group.
    it("puts NULL and out-of-range sources into one null bucket", async () => {
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

    // WHY: a TEXT value in the numeric column (SQLite keeps it as TEXT) labels NULL.
    it("labels a TEXT-stored value NULL", async () => {
      driver.run(`UPDATE "bucket_events" SET "closedAt" = 'soon' WHERE "id" = 1`);
      const rows = await agg({
        $groupBy: ["closed"],
        $select: [{ $bucket: "day", $field: "closedAt", $as: "closed" }, n],
        $sort: { closed: 1 },
      });
      expect(rows).toEqual([
        { closed: null, n: 4 },
        { closed: "2026-03-29", n: 1 },
      ]);
    });

    it("combines a bucket with a plain key, aggregates, $having, $sort, pagination and $count", async () => {
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
      const all = await agg({ ...base, $sort: { day: -1, region: 1 } });
      expect(all).toEqual([
        { region: "eu", day: "2027-01-01", n: 1, total: 7 },
        { region: "us", day: "2026-03-30", n: 1, total: null },
        { region: "eu", day: "2026-03-29", n: 1, total: 20 },
        { region: "us", day: "2026-03-29", n: 1, total: 5 },
      ]);
      expect(await agg({ ...base, $sort: { day: -1, region: 1 }, $skip: 1, $limit: 2 })).toEqual(
        all.slice(1, 3),
      );
      expect(await agg({ ...base, $count: true })).toEqual([{ count: 4 }]);
      expect(
        await agg({ ...base, $having: { $and: [base.$having, { n: { $gt: 1 } }] }, $count: true }),
      ).toEqual([{ count: 0 }]);
    });

    it("applies the row filter before bucketing", async () => {
      const rows = await agg(
        {
          $groupBy: ["month"],
          $select: [{ $bucket: "month", $field: "openedAt", $as: "month" }, n],
        },
        { openedAt: { $gte: at("2026-03-29T00:00:00Z"), $lt: at("2026-04-01T00:00:00Z") } },
      );
      expect(rows).toEqual([{ month: "2026-03-01", n: 2 }]);
    });
  });
});
