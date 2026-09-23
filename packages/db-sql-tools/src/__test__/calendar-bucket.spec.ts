import { describe, it, expect } from "vite-plus/test";
import { BUCKET_UNITS, type BucketUnit } from "@uniqu/core";
import { UniquSelect, type TDbFieldMeta, type TResolvedBucket } from "@atscript/db";

import { buildAggregateSelect, buildAggregateCount, groupKeySql } from "../agg";
import { sqlTimeZoneLiteral } from "../common";
import type { SqlDialect, TSqlFragment } from "../dialect";

/**
 * Calendar buckets in the shared SQL layer (since 0.1.132): the dialect's
 * `calendarBucket` expression renders in SELECT (`AS alias`), GROUP BY,
 * HAVING and the count query's GROUP BY; ORDER BY keeps the alias; the
 * expression is parameter-free, so bind parameters are exactly those of the
 * same query without the bucket.
 */

const baseDialect: SqlDialect = {
  quoteIdentifier: (name) => `"${name}"`,
  quoteTable: (name) => `"${name}"`,
  unlimitedLimit: "-1",
  toValue: (v) => v,
  toParam: (v) => v,
  regex: (col, v) => ({ sql: `${col} LIKE ?`, params: [String(v)] }),
  createViewPrefix: "CREATE VIEW",
  paramPlaceholder: (i) => `$${i}`,
};

const dialect: SqlDialect = {
  ...baseDialect,
  calendarBucket: (col, b) =>
    `BUCKET(${col}, '${b.unit}', ${sqlTimeZoneLiteral(b.tz)}, ${b.weekStartIso})`,
};

const fd = { path: "openedAt", physicalName: "opened_at" } as TDbFieldMeta;

function bucket(unit: BucketUnit, extra: Partial<TResolvedBucket> = {}): TResolvedBucket {
  return {
    alias: "d",
    field: "opened_at",
    unit,
    tz: "Europe/Berlin",
    weekStart: "mon",
    weekStartIso: 1,
    fd,
    ...extra,
  };
}

const where: TSqlFragment = { sql: `"status" = ?`, params: ["open"] };
const n = { $fn: "count", $field: "*", $as: "n" };

/** Controls grouping by `status` plus (optionally) the calendar bucket `d`. */
function controls(b: TResolvedBucket | undefined, extra: Record<string, unknown> = {}) {
  const select = b
    ? ["status", { $bucket: b.unit, $field: b.field, $as: b.alias }, n]
    : ["status", n];
  return {
    $groupBy: b ? ["status", b.alias] : ["status"],
    $select: new UniquSelect(select as any, undefined, b ? [b] : undefined),
    ...extra,
  } as any;
}

describe("buildAggregateSelect — calendar buckets", () => {
  it.each(BUCKET_UNITS)(
    "%s: expression in SELECT / GROUP BY / HAVING, alias in ORDER BY",
    (unit) => {
      const b = bucket(unit);
      const expr = `BUCKET("opened_at", '${unit}', 'Europe/Berlin', 1)`;
      const result = buildAggregateSelect(
        dialect,
        "tickets",
        where,
        controls(b, {
          $having: { d: { $gte: "2026-03-01" }, n: { $gt: 1 } },
          $sort: { d: 1, status: -1 },
          $limit: 10,
          $skip: 20,
        }),
      );
      expect(result.sql).toBe(
        `SELECT "status", ${expr} AS "d", COUNT(*) AS "n" FROM "tickets" WHERE "status" = $1` +
          ` GROUP BY "status", ${expr}` +
          ` HAVING ${expr} >= $2 AND COUNT(*) > $3` +
          ` ORDER BY "d" ASC, "status" DESC LIMIT $4 OFFSET $5`,
      );
      expect(result.params).toEqual(["open", "2026-03-01", 1, 10, 20]);
    },
  );

  it("bind parameters are identical to the same query without the bucket", () => {
    const extra = { $having: { n: { $gt: 1 } }, $limit: 5, $skip: 1 };
    const withBucket = buildAggregateSelect(dialect, "t", where, controls(bucket("week"), extra));
    const without = buildAggregateSelect(dialect, "t", where, controls(undefined, extra));
    expect(withBucket.params).toEqual(without.params);
    const countWith = buildAggregateCount(dialect, "t", where, controls(bucket("week"), extra));
    const countWithout = buildAggregateCount(dialect, "t", where, controls(undefined, extra));
    expect(countWith.params).toEqual(countWithout.params);
  });

  it("week start and zone reach the dialect as resolved", () => {
    const b = bucket("week", { tz: "America/New_York", weekStart: "sun", weekStartIso: 7 });
    const result = buildAggregateSelect(dialect, "t", { sql: "1=1", params: [] }, controls(b));
    expect(result.sql).toContain(`BUCKET("opened_at", 'week', 'America/New_York', 7) AS "d"`);
  });
});

describe("buildAggregateCount — calendar buckets", () => {
  it("groups by the expression, so $count counts the buckets that survive $having", () => {
    const expr = `BUCKET("opened_at", 'day', 'Europe/Berlin', 1)`;
    const plain = buildAggregateCount(dialect, "t", where, controls(bucket("day")));
    expect(plain.sql).toBe(
      `SELECT COUNT(*) AS "count" FROM (SELECT ${expr} AS "d" FROM "t" WHERE "status" = $1 GROUP BY "status", ${expr}) AS "_groups"`,
    );
    const having = buildAggregateCount(
      dialect,
      "t",
      where,
      controls(bucket("day"), { $having: { d: { $lt: "2026-04-01" } } }),
    );
    expect(having.sql).toBe(
      `SELECT COUNT(*) AS "count" FROM (SELECT ${expr} AS "d" FROM "t" WHERE "status" = $1 GROUP BY "status", ${expr} HAVING ${expr} < $2) AS "_groups"`,
    );
    expect(having.params).toEqual(["open", "2026-04-01"]);
  });
});

describe("bucketAliasInHaving (MySQL-style HAVING)", () => {
  const aliasDialect: SqlDialect = { ...dialect, bucketAliasInHaving: true };
  const expr = `BUCKET("opened_at", 'day', 'Europe/Berlin', 1)`;
  const having = { $having: { d: { $gte: "2026-03-01" }, n: { $gt: 1 } } };

  it("HAVING names the bucket by alias; aggregates stay inlined; GROUP BY keeps the expression", () => {
    const result = buildAggregateSelect(
      aliasDialect,
      "t",
      where,
      controls(bucket("day"), { ...having, $sort: { d: -1 }, $limit: 10 }),
    );
    expect(result.sql).toBe(
      `SELECT "status", ${expr} AS "d", COUNT(*) AS "n" FROM "t" WHERE "status" = $1` +
        ` GROUP BY "status", ${expr}` +
        ` HAVING "d" >= $2 AND COUNT(*) > $3` +
        ` ORDER BY "d" DESC LIMIT $4`,
    );
    expect(result.params).toEqual(["open", "2026-03-01", 1, 10]);
  });

  it("count query's inner SELECT defines the bucket alias HAVING references", () => {
    const result = buildAggregateCount(aliasDialect, "t", where, controls(bucket("day"), having));
    expect(result.sql).toBe(
      `SELECT COUNT(*) AS "count" FROM (SELECT ${expr} AS "d" FROM "t" WHERE "status" = $1` +
        ` GROUP BY "status", ${expr} HAVING "d" >= $2 AND COUNT(*) > $3) AS "_groups"`,
    );
    expect(result.params).toEqual(["open", "2026-03-01", 1]);
  });

  it("bind parameters match the expression-form dialect", () => {
    const extra = { ...having, $limit: 5, $skip: 1 };
    for (const build of [buildAggregateSelect, buildAggregateCount]) {
      const withAlias = build(aliasDialect, "t", where, controls(bucket("week"), extra));
      const withExpr = build(dialect, "t", where, controls(bucket("week"), extra));
      expect(withAlias.params).toEqual(withExpr.params);
    }
  });

  it("without buckets nothing changes (plain grouped column in HAVING, `SELECT 1` count)", () => {
    const extra = { $having: { status: "open", n: { $gt: 1 } } };
    for (const build of [buildAggregateSelect, buildAggregateCount]) {
      const withFlag = build(aliasDialect, "t", where, controls(undefined, extra));
      const without = build(dialect, "t", where, controls(undefined, extra));
      expect(withFlag).toEqual(without);
    }
    expect(buildAggregateCount(aliasDialect, "t", where, controls(undefined, extra)).sql).toBe(
      `SELECT COUNT(*) AS "count" FROM (SELECT 1 FROM "t" WHERE "status" = $1` +
        ` GROUP BY "status" HAVING "status" = $2 AND COUNT(*) > $3) AS "_groups"`,
    );
  });
});

describe("inlined bucket literals (defense in depth)", () => {
  it("rejects a unit / week start / zone outside its closed set before the dialect renders", () => {
    for (const bad of [
      bucket("hour" as BucketUnit),
      bucket("day", { weekStart: "x'" as never }),
      bucket("week", { weekStartIso: 8 as never }),
      bucket("day", { tz: "UTC'; DROP TABLE x;--" }),
    ]) {
      expect(() => buildAggregateSelect(dialect, "t", where, controls(bad))).toThrow(
        expect.objectContaining({ code: "INVALID_QUERY" }),
      );
    }
  });
});

describe("dialect without calendarBucket", () => {
  it("throws BUCKET_NOT_SUPPORTED from every builder", () => {
    for (const run of [
      () => buildAggregateSelect(baseDialect, "t", where, controls(bucket("day"))),
      () => buildAggregateCount(baseDialect, "t", where, controls(bucket("day"))),
    ]) {
      expect(run).toThrow(expect.objectContaining({ code: "BUCKET_NOT_SUPPORTED" }));
    }
  });

  it("plain group keys still render as quoted columns", () => {
    expect(groupKeySql(baseDialect, controls(undefined), "status")).toBe(`"status"`);
  });
});

describe("sqlTimeZoneLiteral", () => {
  it("inlines a canonical zone name", () => {
    expect(sqlTimeZoneLiteral("UTC")).toBe("'UTC'");
    expect(sqlTimeZoneLiteral("America/Argentina/Buenos_Aires")).toBe(
      "'America/Argentina/Buenos_Aires'",
    );
    expect(sqlTimeZoneLiteral("Etc/GMT+5")).toBe("'Etc/GMT+5'");
  });

  it("re-asserts the zone charset (defense in depth)", () => {
    for (const bad of ["UTC'; DROP TABLE x;--", "Europe/Berlin ", "a\\b", "", "x".repeat(65)]) {
      expect(() => sqlTimeZoneLiteral(bad), bad).toThrow(
        expect.objectContaining({ code: "INVALID_QUERY" }),
      );
    }
  });
});
