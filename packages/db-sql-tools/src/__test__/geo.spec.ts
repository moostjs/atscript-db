import { describe, it, expect } from "vite-plus/test";

import type { SqlDialect } from "../dialect";
import {
  buildGeoSearchCount,
  buildGeoSearchSelect,
  geoWindowFromControls,
  normalizeGeoPointValue,
  renameGeoDistance,
} from "../geo";
import { buildWhere } from "../filter-builder";
import { toSqlValue } from "../common";

const dialect: SqlDialect = {
  quoteIdentifier: (n) => `"${n}"`,
  quoteTable: (n) => `"${n}"`,
  unlimitedLimit: "-1",
  toValue: toSqlValue,
  toParam: (v) => v,
  regex: () => ({ sql: "", params: [] }),
  createViewPrefix: "CREATE VIEW",
};

const DIST = { sql: `dist("geo", ?, ?)`, params: [1, 2] };

describe("geo SQL builders", () => {
  it("builds a distance-ranked subquery select with window and pagination", () => {
    const { sql, params } = buildGeoSearchSelect(
      dialect,
      "places",
      { sql: `"city" = ?`, params: ["SF"] },
      DIST,
      { maxDistance: 500, minDistance: 10 },
      { $limit: 5, $skip: 2 },
    );
    expect(sql).toBe(
      `SELECT * FROM (SELECT "t".*, dist("geo", ?, ?) AS "__atscript_distance" FROM "places" AS "t" WHERE "city" = ?) AS "_g" ` +
        `WHERE "__atscript_distance" IS NOT NULL AND "__atscript_distance" <= ? AND "__atscript_distance" >= ? ` +
        `ORDER BY "__atscript_distance" ASC LIMIT ? OFFSET ?`,
    );
    expect(params).toEqual([1, 2, "SF", 500, 10, 5, 2]);
  });

  it("omits LIMIT when no pagination controls are given (MongoDB parity)", () => {
    const { sql } = buildGeoSearchSelect(
      dialect,
      "places",
      { sql: "1=1", params: [] },
      DIST,
      {},
      {},
    );
    expect(sql).not.toContain("LIMIT");
    expect(sql).not.toContain("OFFSET");
  });

  it("builds the windowed count companion", () => {
    const { sql, params } = buildGeoSearchCount(
      dialect,
      "places",
      { sql: "1=1", params: [] },
      DIST,
      { maxDistance: 500 },
    );
    expect(sql).toBe(
      `SELECT COUNT(*) AS cnt FROM (SELECT dist("geo", ?, ?) AS "__atscript_distance" FROM "places" AS "t" WHERE 1=1) AS "_g" ` +
        `WHERE "__atscript_distance" IS NOT NULL AND "__atscript_distance" <= ?`,
    );
    expect(params).toEqual([1, 2, 500]);
  });

  it("extracts the distance window from query controls", () => {
    expect(geoWindowFromControls({ $maxDistance: 100, $minDistance: 5 })).toEqual({
      maxDistance: 100,
      minDistance: 5,
    });
    expect(geoWindowFromControls(undefined)).toEqual({
      maxDistance: undefined,
      minDistance: undefined,
    });
  });

  it("renames the internal distance alias to $distance", () => {
    const row = { id: 1, __atscript_distance: 42 };
    expect(renameGeoDistance(row)).toEqual({ id: 1, $distance: 42 });
    // string distances (e.g. PG numeric) are coerced to number
    expect(renameGeoDistance({ __atscript_distance: "1.5" }).$distance).toBe(1.5);
    // untouched when alias is absent
    expect(renameGeoDistance({ id: 2 })).toEqual({ id: 2 });
  });

  it("normalizes tuple and JSON-string geo values, passing other shapes through", () => {
    expect(normalizeGeoPointValue([1, 2])).toEqual([1, 2]);
    expect(normalizeGeoPointValue("[1,2]")).toEqual([1, 2]);
    expect(normalizeGeoPointValue({ center: [1, 2], radius: 5 })).toBeUndefined();
    expect(normalizeGeoPointValue("SRID=4326;POINT(1 2)")).toBeUndefined();
    expect(normalizeGeoPointValue([1, 2, 3])).toBeUndefined();
    expect(normalizeGeoPointValue(null)).toBeUndefined();
  });
});

describe("$geoWithin filter dispatch", () => {
  it("throws GEO_NOT_SUPPORTED for dialects without a geoWithin hook", () => {
    expect(() =>
      buildWhere(dialect, { geo: { $geoWithin: { center: [1, 2], radius: 5 } } } as any),
    ).toThrowError(/geoWithin is not supported/);
  });

  it("delegates to the dialect geoWithin hook when present", () => {
    const geoDialect: SqlDialect = {
      ...dialect,
      geoWithin: (col, circle) => ({
        sql: `${col} WITHIN ? ?`,
        params: [circle.center.join(","), circle.radius],
      }),
    };
    const { sql, params } = buildWhere(geoDialect, {
      geo: { $geoWithin: { center: [1, 2], radius: 5 } },
    } as any);
    expect(sql).toBe(`"geo" WITHIN ? ?`);
    expect(params).toEqual(["1,2", 5]);
  });
});

describe("toSqlValue binary passthrough", () => {
  it("passes Buffers and Uint8Arrays through instead of JSON-mangling them", () => {
    const buf = Buffer.from([1, 2, 3]);
    expect(toSqlValue(buf)).toBe(buf);
    const arr = new Uint8Array([4, 5]);
    expect(toSqlValue(arr)).toBe(arr);
    // plain objects still serialize to JSON
    expect(toSqlValue({ a: 1 })).toBe('{"a":1}');
  });
});
