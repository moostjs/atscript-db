import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable, DbError, type TDbFieldMeta, type TResolvedBucket } from "@atscript/db";
import { BUCKET_UNITS, type BucketUnit } from "@uniqu/core";

import { PostgresAdapter } from "../postgres-adapter";
import { pgCalendarBucket } from "../sql-builder";

import { prepareFixtures, createMockDriver } from "./test-utils";

/**
 * Calendar buckets on PostgreSQL (since 0.1.132): the `pgCalendarBucket`
 * label expression per unit, its wiring through the aggregate builders, and
 * the unknown-zone (SQLSTATE 22023) mapping to `BUCKET_TZ_UNAVAILABLE`.
 */

let BucketTicket: any;

beforeAll(async () => {
  await prepareFixtures();
  BucketTicket = (await import("./fixtures/bucket-tickets.as")).BucketTicket;
});

const fd = { path: "openedAt", physicalName: "openedAt", designType: "number" } as TDbFieldMeta;

function bucket(unit: BucketUnit, extra: Partial<TResolvedBucket> = {}): TResolvedBucket {
  return {
    alias: "b",
    field: "openedAt",
    unit,
    tz: "Europe/Berlin",
    weekStart: "mon",
    weekStartIso: 1,
    fd,
    ...extra,
  };
}

const L = `(to_timestamp("openedAt"::double precision / 1000) AT TIME ZONE 'Europe/Berlin')::date`;
const wrap = (first: string) =>
  `CASE WHEN "openedAt" >= 86400000 AND "openedAt" < 32503680000000 THEN to_char(${first}::timestamp, 'YYYY-MM-DD') END`;

describe("pgCalendarBucket", () => {
  it("day: the local date", () => {
    expect(pgCalendarBucket(`"openedAt"`, bucket("day"))).toBe(wrap(L));
  });

  it("week: the generic week-start formula (not date_trunc('week'))", () => {
    expect(pgCalendarBucket(`"openedAt"`, bucket("week"))).toBe(
      wrap(`(${L} - ((EXTRACT(ISODOW FROM ${L})::int - 1 + 7) % 7))`),
    );
    expect(
      pgCalendarBucket(`"openedAt"`, bucket("week", { weekStart: "sun", weekStartIso: 7 })),
    ).toBe(wrap(`(${L} - ((EXTRACT(ISODOW FROM ${L})::int - 7 + 7) % 7))`));
  });

  it.each(["month", "quarter", "year"] as const)(
    "%s: date_trunc over an explicit timestamp (not the session-zone timestamptz overload)",
    (unit) => {
      expect(pgCalendarBucket(`"openedAt"`, bucket(unit))).toBe(
        wrap(`date_trunc('${unit}', ${L}::timestamp)`),
      );
    },
  );

  it("UTC renders like any other zone", () => {
    expect(pgCalendarBucket(`"openedAt"`, bucket("day", { tz: "UTC" }))).toBe(
      wrap(`(to_timestamp("openedAt"::double precision / 1000) AT TIME ZONE 'UTC')::date`),
    );
  });

  it.each(BUCKET_UNITS)("%s: parameter-free, zone inlined once per local-date use", (unit) => {
    const sql = pgCalendarBucket(`"openedAt"`, bucket(unit));
    expect(sql).not.toMatch(/\?|\$\d/);
    expect(sql).toContain("'Europe/Berlin'");
  });

  it("rejects a zone outside the SQL-inlining charset", () => {
    expect(() =>
      pgCalendarBucket(`"openedAt"`, bucket("day", { tz: "UTC'; DROP TABLE x;--" })),
    ).toThrow(DbError);
  });
});

// ── Unknown-zone mapping fixtures ────────────────────────────────────────────

const zoneError = () =>
  Object.assign(new Error('time zone "America/Ciudad_Juarez" not recognized'), {
    code: "22023",
  });
const controls = (extra: Record<string, unknown> = {}) =>
  ({
    $select: [
      { $bucket: "day", $field: "openedAt", $tz: "America/Ciudad_Juarez", $as: "day" },
      { $fn: "count", $field: "*", $as: "n" },
    ],
    $groupBy: ["day"],
    ...extra,
  }) as any;

function throwingDriver(error: () => unknown) {
  const driver = createMockDriver();
  driver.all = async () => {
    throw error();
  };
  driver.get = async () => {
    throw error();
  };
  return driver;
}

describe("PostgresAdapter calendar buckets", () => {
  it("advertises all five units", () => {
    const adapter = new PostgresAdapter(createMockDriver());
    expect([...adapter.calendarBucketUnits()]).toEqual([...BUCKET_UNITS]);
  });

  it("renders the bucket in SELECT and GROUP BY, the alias in ORDER BY; params unchanged", async () => {
    const driver = createMockDriver({ allResult: [{ week: "2026-03-29", n: 2 }] });
    const table = new AtscriptDbTable(BucketTicket, new PostgresAdapter(driver));

    const result = await table.aggregate({
      filter: { status: "open" },
      controls: {
        $select: [
          {
            $bucket: "week",
            $field: "openedAt",
            $tz: "Europe/Berlin",
            $weekStart: "sun",
            $as: "week",
          },
          { $fn: "count", $field: "*", $as: "n" },
        ],
        $groupBy: ["week"],
        $sort: { week: 1 },
        $limit: 5,
      } as any,
    });

    expect(result).toEqual([{ week: "2026-03-29", n: 2 }]);
    const expr = pgCalendarBucket(
      `"openedAt"`,
      bucket("week", { alias: "week", weekStart: "sun", weekStartIso: 7 }),
    );
    const call = driver.calls[0];
    expect(call.sql).toBe(
      `SELECT ${expr} AS "week", COUNT(*) AS "n" FROM "bucket_tickets" WHERE "status" = $1 GROUP BY ${expr} ORDER BY "week" ASC LIMIT $2`,
    );
    expect(call.params).toEqual(["open", 5]);
  });

  it("the BIGINT @db.default.now column uses the same expression", async () => {
    const driver = createMockDriver({ allResult: [] });
    const table = new AtscriptDbTable(BucketTicket, new PostgresAdapter(driver));

    await table.aggregate({
      filter: {},
      controls: {
        $select: [{ $bucket: "day", $field: "createdAt", $as: "day" }],
        $groupBy: ["day"],
      } as any,
    });

    expect(driver.calls[0].sql).toBe(
      `SELECT CASE WHEN "createdAt" >= 86400000 AND "createdAt" < 32503680000000 THEN to_char((to_timestamp("createdAt"::double precision / 1000) AT TIME ZONE 'UTC')::date::timestamp, 'YYYY-MM-DD') END AS "day" FROM "bucket_tickets" WHERE 1=1 GROUP BY CASE WHEN "createdAt" >= 86400000 AND "createdAt" < 32503680000000 THEN to_char((to_timestamp("createdAt"::double precision / 1000) AT TIME ZONE 'UTC')::date::timestamp, 'YYYY-MM-DD') END`,
    );
  });

  describe("unknown zone (SQLSTATE 22023)", () => {
    it("maps to BUCKET_TZ_UNAVAILABLE on the row query", async () => {
      const table = new AtscriptDbTable(
        BucketTicket,
        new PostgresAdapter(throwingDriver(zoneError)),
      );
      const err = await table.aggregate({ filter: {}, controls: controls() }).catch((e) => e);
      expect(err).toBeInstanceOf(DbError);
      expect(err.code).toBe("BUCKET_TZ_UNAVAILABLE");
      expect(err.errors).toEqual([
        {
          path: "$select",
          message:
            'PostgreSQL does not recognize time zone "America/Ciudad_Juarez" — update the server\'s time zone data',
        },
      ]);
    });

    it("maps to BUCKET_TZ_UNAVAILABLE on the $count query", async () => {
      const table = new AtscriptDbTable(
        BucketTicket,
        new PostgresAdapter(throwingDriver(zoneError)),
      );
      const err = await table
        .aggregate({ filter: {}, controls: controls({ $count: true }) })
        .catch((e) => e);
      expect(err.code).toBe("BUCKET_TZ_UNAVAILABLE");
    });

    it("leaves other 22023 errors and other codes untouched", async () => {
      const other = Object.assign(new Error("invalid value for parameter"), { code: "22023" });
      let table = new AtscriptDbTable(
        BucketTicket,
        new PostgresAdapter(throwingDriver(() => other)),
      );
      await expect(table.aggregate({ filter: {}, controls: controls() })).rejects.toBe(other);

      const syntax = Object.assign(new Error('time zone "X" not recognized'), { code: "42601" });
      table = new AtscriptDbTable(BucketTicket, new PostgresAdapter(throwingDriver(() => syntax)));
      await expect(table.aggregate({ filter: {}, controls: controls() })).rejects.toBe(syntax);
    });
  });
});
