import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable, DbError, type TDbFieldMeta, type TResolvedBucket } from "@atscript/db";
import { BUCKET_UNITS, type BucketUnit } from "@uniqu/core";

import { MysqlAdapter } from "../mysql-adapter";
import { isMysqlTimestampColumn, mysqlCalendarBucket, mysqlTypeFromField } from "../sql-builder";

import { prepareFixtures, createMockDriver } from "./test-utils";

/**
 * Calendar buckets on MySQL (since 0.1.132): the `mysqlCalendarBucket` label
 * expression per unit and storage kind (DOUBLE epoch ms vs native TIMESTAMP),
 * the `UTC` path without `CONVERT_TZ`, and the per-driver `CONVERT_TZ` zone
 * probe (`BUCKET_TZ_UNAVAILABLE`).
 */

let BucketTicket: any;

beforeAll(async () => {
  await prepareFixtures();
  BucketTicket = (await import("./fixtures/bucket-tickets.as")).BucketTicket;
});

const doubleFd = {
  path: "openedAt",
  physicalName: "openedAt",
  designType: "number",
} as TDbFieldMeta;
const timestampFd = {
  path: "createdAt",
  physicalName: "createdAt",
  designType: "number",
  defaultValue: { kind: "fn", fn: "now" },
} as TDbFieldMeta;

function bucket(unit: BucketUnit, extra: Partial<TResolvedBucket> = {}): TResolvedBucket {
  return {
    alias: "b",
    field: "openedAt",
    unit,
    tz: "Europe/Berlin",
    weekStart: "mon",
    weekStartIso: 1,
    fd: doubleFd,
    ...extra,
  };
}

const U_DOUBLE = `(CAST('1970-01-01 00:00:00' AS DATETIME) + INTERVAL FLOOR("openedAt" / 1000) SECOND)`;
const GUARD_DOUBLE = `"openedAt" >= 86400000 AND "openedAt" < 32503680000000`;
const L = `DATE(CONVERT_TZ(${U_DOUBLE}, '+00:00', 'Europe/Berlin'))`;
const wrap = (first: string, guard = GUARD_DOUBLE) =>
  `CASE WHEN ${guard} THEN DATE_FORMAT(${first}, '%Y-%m-%d') END`;

describe("isMysqlTimestampColumn", () => {
  it("is exactly the fields mapped to TIMESTAMP", () => {
    expect(isMysqlTimestampColumn(timestampFd)).toBe(true);
    expect(isMysqlTimestampColumn(doubleFd)).toBe(false);
    expect(
      isMysqlTimestampColumn({
        ...doubleFd,
        defaultValue: { kind: "fn", fn: "increment" },
      } as TDbFieldMeta),
    ).toBe(false);
    expect(mysqlTypeFromField(timestampFd)).toBe("TIMESTAMP");
    expect(mysqlTypeFromField(doubleFd)).toBe("DOUBLE");
  });
});

describe("mysqlCalendarBucket", () => {
  it("day: the local date", () => {
    expect(mysqlCalendarBucket(`"openedAt"`, bucket("day"))).toBe(wrap(L));
  });

  it("week: WEEKDAY-based week-start formula", () => {
    expect(mysqlCalendarBucket(`"openedAt"`, bucket("week"))).toBe(
      wrap(`DATE_SUB(${L}, INTERVAL ((WEEKDAY(${L}) + 1 - 1 + 7) % 7) DAY)`),
    );
    expect(
      mysqlCalendarBucket(`"openedAt"`, bucket("week", { weekStart: "sun", weekStartIso: 7 })),
    ).toBe(wrap(`DATE_SUB(${L}, INTERVAL ((WEEKDAY(${L}) + 1 - 7 + 7) % 7) DAY)`));
  });

  it("month", () => {
    expect(mysqlCalendarBucket(`"openedAt"`, bucket("month"))).toBe(
      wrap(`DATE_SUB(${L}, INTERVAL DAYOFMONTH(${L}) - 1 DAY)`),
    );
  });

  it("quarter", () => {
    expect(mysqlCalendarBucket(`"openedAt"`, bucket("quarter"))).toBe(
      wrap(`(MAKEDATE(YEAR(${L}), 1) + INTERVAL (QUARTER(${L}) - 1) QUARTER)`),
    );
  });

  it("year", () => {
    expect(mysqlCalendarBucket(`"openedAt"`, bucket("year"))).toBe(wrap(`MAKEDATE(YEAR(${L}), 1)`));
  });

  it("UTC skips CONVERT_TZ", () => {
    for (const unit of BUCKET_UNITS) {
      const sql = mysqlCalendarBucket(`"openedAt"`, bucket(unit, { tz: "UTC" }));
      expect(sql).not.toContain("CONVERT_TZ");
      expect(sql).toContain(`DATE(${U_DOUBLE})`);
    }
    expect(mysqlCalendarBucket(`"openedAt"`, bucket("day", { tz: "UTC" }))).toBe(
      wrap(`DATE(${U_DOUBLE})`),
    );
  });

  it("native TIMESTAMP: the session rendering of the column, guarded on it (no UNIX_TIMESTAMP / FROM_UNIXTIME)", () => {
    const b = bucket("month", { field: "createdAt", fd: timestampFd });
    const U = `CAST("createdAt" AS DATETIME)`;
    const local = `DATE(CONVERT_TZ(${U}, '+00:00', 'Europe/Berlin'))`;
    expect(mysqlCalendarBucket(`"createdAt"`, b)).toBe(
      wrap(
        `DATE_SUB(${local}, INTERVAL DAYOFMONTH(${local}) - 1 DAY)`,
        `${U} >= '1970-01-02 00:00:00'`,
      ),
    );
    expect(mysqlCalendarBucket(`"createdAt"`, { ...b, unit: "day", tz: "UTC" })).toBe(
      wrap(`DATE(${U})`, `${U} >= '1970-01-02 00:00:00'`),
    );
  });

  it.each(BUCKET_UNITS)("%s: parameter-free and session-zone free", (unit) => {
    for (const fd of [doubleFd, timestampFd]) {
      const sql = mysqlCalendarBucket(`"c"`, bucket(unit, { fd }));
      expect(sql).not.toContain("?");
      expect(sql).not.toMatch(/FROM_UNIXTIME|UNIX_TIMESTAMP|NOW\(|CURDATE/);
    }
  });

  it("rejects a zone outside the SQL-inlining charset", () => {
    expect(() => mysqlCalendarBucket(`"openedAt"`, bucket("day", { tz: "x' OR 1=1 --" }))).toThrow(
      DbError,
    );
  });
});

// ── Adapter: capability, wiring and the CONVERT_TZ probe ─────────────────────

const PROBE = "CONVERT_TZ('2040-06-01 12:00:00', '+00:00', ?)";
/** Probe row of a server with the tz tables loaded and the full 64-bit range. */
const OK = { missing: 0, shift: 60 };

function selectBucket(tz: string, field = "openedAt") {
  return {
    $select: [
      { $bucket: "day", $field: field, $tz: tz, $as: "day" },
      { $fn: "count", $field: "*", $as: "n" },
    ],
    $groupBy: ["day"],
  } as any;
}

describe("MysqlAdapter calendar buckets", () => {
  it("advertises all five units", () => {
    expect([...new MysqlAdapter(createMockDriver()).calendarBucketUnits()]).toEqual([
      ...BUCKET_UNITS,
    ]);
  });

  it("renders the bucket in SELECT and GROUP BY after a successful probe; params unchanged", async () => {
    const driver = createMockDriver({
      get: [[PROBE, OK]],
      allResult: [{ day: "2026-03-29", n: 2 }],
    });
    const table = new AtscriptDbTable(BucketTicket, new MysqlAdapter(driver));

    const result = await table.aggregate({
      filter: { status: "open" },
      controls: { ...selectBucket("Europe/Berlin"), $sort: { day: -1 }, $limit: 3 },
    });

    expect(result).toEqual([{ day: "2026-03-29", n: 2 }]);
    expect(driver.calls.map((c) => c.method)).toEqual(["get", "all"]);
    expect(driver.calls[0].sql).toBe(
      "SELECT CONVERT_TZ('2040-06-01 12:00:00', '+00:00', ?) IS NULL AS missing, " +
        "TIMESTAMPDIFF(MINUTE, '2040-06-01 12:00:00', CONVERT_TZ('2040-06-01 12:00:00', '+00:00', '+01:00')) AS shift",
    );
    expect(driver.calls[0].params).toEqual(["Europe/Berlin"]);
    const expr = mysqlCalendarBucket("`openedAt`", bucket("day", { alias: "day" }));
    expect(driver.calls[1].sql).toBe(
      `SELECT ${expr} AS \`day\`, COUNT(*) AS \`n\` FROM \`bucket_tickets\` WHERE \`status\` = ? GROUP BY ${expr} ORDER BY \`day\` DESC LIMIT ?`,
    );
    expect(driver.calls[1].params).toEqual(["open", 3]);
  });

  // MySQL rejects the bucket expression in HAVING (it reads the raw column,
  // which is not in GROUP BY — ER 1054), so HAVING names the bucket by its
  // SELECT alias; aggregates stay inlined.
  it("HAVING references the bucket by alias; aggregates inlined; params unchanged", async () => {
    const driver = createMockDriver({ allResult: [] });
    const table = new AtscriptDbTable(BucketTicket, new MysqlAdapter(driver));
    await table.aggregate({
      filter: { status: "open" },
      controls: {
        ...selectBucket("UTC"),
        $having: { day: { $gte: "2026-03-01" }, n: { $gt: 1 } },
        $sort: { day: 1 },
      },
    });
    const expr = mysqlCalendarBucket("`openedAt`", bucket("day", { alias: "day", tz: "UTC" }));
    expect(driver.calls[0].sql).toBe(
      `SELECT ${expr} AS \`day\`, COUNT(*) AS \`n\` FROM \`bucket_tickets\` WHERE \`status\` = ?` +
        ` GROUP BY ${expr} HAVING \`day\` >= ? AND COUNT(*) > ? ORDER BY \`day\` ASC`,
    );
    expect(driver.calls[0].params).toEqual(["open", "2026-03-01", 1]);
  });

  it("$count's inner SELECT defines the bucket alias its HAVING references", async () => {
    const driver = createMockDriver({ getResult: { count: 4 } });
    const table = new AtscriptDbTable(BucketTicket, new MysqlAdapter(driver));
    const result = await table.aggregate({
      filter: { status: "open" },
      controls: {
        ...selectBucket("UTC"),
        $having: { day: { $gte: "2026-03-01" }, n: { $gt: 1 } },
        $count: true,
      },
    });
    expect(result).toEqual([{ count: 4 }]);
    const expr = mysqlCalendarBucket("`openedAt`", bucket("day", { alias: "day", tz: "UTC" }));
    expect(driver.calls[0].sql).toBe(
      `SELECT COUNT(*) AS \`count\` FROM (SELECT ${expr} AS \`day\` FROM \`bucket_tickets\`` +
        ` WHERE \`status\` = ? GROUP BY ${expr} HAVING \`day\` >= ? AND COUNT(*) > ?) AS \`_groups\``,
    );
    expect(driver.calls[0].params).toEqual(["open", "2026-03-01", 1]);
  });

  it("a @db.default.now source renders the TIMESTAMP form", async () => {
    const driver = createMockDriver({ allResult: [] });
    const table = new AtscriptDbTable(BucketTicket, new MysqlAdapter(driver));
    await table.aggregate({ filter: {}, controls: selectBucket("UTC", "createdAt") });
    expect(driver.calls[0].sql).toContain(
      "CASE WHEN CAST(`createdAt` AS DATETIME) >= '1970-01-02 00:00:00' THEN DATE_FORMAT(DATE(CAST(`createdAt` AS DATETIME)), '%Y-%m-%d') END AS `day`",
    );
  });

  it("UTC never probes", async () => {
    const driver = createMockDriver({ allResult: [] });
    const table = new AtscriptDbTable(BucketTicket, new MysqlAdapter(driver));
    await table.aggregate({ filter: {}, controls: selectBucket("UTC") });
    await table.aggregate({ filter: {}, controls: { ...selectBucket("UTC"), $count: true } });
    expect(driver.calls.some((c) => c.sql.includes("CONVERT_TZ"))).toBe(false);
  });

  it("a NULL probe (tz tables missing / zone unknown) raises BUCKET_TZ_UNAVAILABLE before the query", async () => {
    const driver = createMockDriver({ get: [[PROBE, { missing: 1, shift: 60 }]] });
    const table = new AtscriptDbTable(BucketTicket, new MysqlAdapter(driver));
    const err = await table
      .aggregate({ filter: {}, controls: selectBucket("Europe/Berlin") })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err.code).toBe("BUCKET_TZ_UNAVAILABLE");
    expect(err.errors).toEqual([
      {
        path: "$select",
        message:
          'MySQL cannot convert to time zone "Europe/Berlin": its time zone tables are not loaded or lack this zone — load them with mysql_tzinfo_to_sql',
      },
    ]);
    expect(driver.calls).toHaveLength(1);
  });

  it("an unconverted post-2038 fixed-offset result (pre-8.0.28 range) raises BUCKET_TZ_UNAVAILABLE", async () => {
    const driver = createMockDriver({ get: [[PROBE, { missing: 0, shift: 0 }]] });
    const table = new AtscriptDbTable(BucketTicket, new MysqlAdapter(driver));
    const err = await table
      .aggregate({ filter: {}, controls: { ...selectBucket("Asia/Kolkata"), $count: true } })
      .catch((e) => e);
    expect(err.code).toBe("BUCKET_TZ_UNAVAILABLE");
    expect(err.errors[0].message).toBe(
      'MySQL cannot convert to time zone "Asia/Kolkata": its CONVERT_TZ does not convert instants after 2038 — MySQL 8.0.28 or later (64-bit) is required',
    );
    expect(driver.calls).toHaveLength(1);
  });

  // MySQL tz tables end in 2037, so Europe/London converts to +00:00 in June
  // 2040 on a current server — the range check must not use the named zone.
  it("the range check is zone-independent (Europe/London passes on a full-range server)", async () => {
    const driver = createMockDriver({ get: [[PROBE, OK]], allResult: [] });
    const table = new AtscriptDbTable(BucketTicket, new MysqlAdapter(driver));
    await table.aggregate({ filter: {}, controls: selectBucket("Europe/London") });
    expect(driver.calls.map((c) => c.method)).toEqual(["get", "all"]);
  });

  it("accepts a driver returning the probe columns as strings or bigints", async () => {
    for (const row of [
      { missing: "0", shift: "60" },
      { missing: 0n, shift: 60n },
    ]) {
      const driver = createMockDriver({ get: [[PROBE, row]], allResult: [] });
      const table = new AtscriptDbTable(BucketTicket, new MysqlAdapter(driver));
      await table.aggregate({ filter: {}, controls: selectBucket("Asia/Kolkata") });
      expect(driver.calls.map((c) => c.method)).toEqual(["get", "all"]);
    }
  });

  it("caches positives per driver (shared by the driver's adapters), not negatives", async () => {
    let missing = 1;
    const driver = createMockDriver({ allResult: [] });
    const get = driver.get.bind(driver);
    driver.get = async (sql, params) => {
      await get(sql, params);
      return (sql.includes("CONVERT_TZ") ? { missing, shift: 60 } : null) as any;
    };
    const probes = () => driver.calls.filter((c) => c.sql.includes(PROBE)).length;
    const table = new AtscriptDbTable(BucketTicket, new MysqlAdapter(driver));
    const run = (t = table) =>
      t.aggregate({ filter: {}, controls: selectBucket("America/New_York") });

    await expect(run()).rejects.toMatchObject({ code: "BUCKET_TZ_UNAVAILABLE" });
    await expect(run()).rejects.toMatchObject({ code: "BUCKET_TZ_UNAVAILABLE" });
    expect(probes()).toBe(2); // negatives re-probe

    missing = 0; // tz tables loaded meanwhile
    await run();
    await run();
    expect(probes()).toBe(3);

    // Another adapter over the same driver reuses the positive
    await run(new AtscriptDbTable(BucketTicket, new MysqlAdapter(driver)));
    expect(probes()).toBe(3);

    // A different driver probes on its own
    const other = createMockDriver({ get: [[PROBE, OK]], allResult: [] });
    await new AtscriptDbTable(BucketTicket, new MysqlAdapter(other)).aggregate({
      filter: {},
      controls: selectBucket("America/New_York"),
    });
    expect(other.calls.filter((c) => c.sql.includes(PROBE))).toHaveLength(1);
  });

  it("probes each distinct non-UTC zone once per query", async () => {
    const driver = createMockDriver({ get: [[PROBE, OK]], allResult: [] });
    const table = new AtscriptDbTable(BucketTicket, new MysqlAdapter(driver));
    await table.aggregate({
      filter: {},
      controls: {
        $select: [
          { $bucket: "day", $field: "openedAt", $tz: "Europe/Paris", $as: "d1" },
          { $bucket: "month", $field: "openedAt", $tz: "Europe/Paris", $as: "d2" },
          { $bucket: "day", $field: "openedAt", $tz: "UTC", $as: "d3" },
        ],
        $groupBy: ["d1", "d2", "d3"],
      } as any,
    });
    expect(driver.calls.filter((c) => c.sql.includes(PROBE)).map((c) => c.params)).toEqual([
      ["Europe/Paris"],
    ]);
  });
});
