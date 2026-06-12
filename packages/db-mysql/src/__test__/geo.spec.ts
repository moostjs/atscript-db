import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { AtscriptDbTable, DbSpace } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { geoPointToMysqlInternal, mysqlGeoValueToPoint } from "../sql-builder";
import { createMockDriver, prepareFixtures } from "./test-utils";

// MySQL geo (phase 2): db.geoPoint → POINT SRID 4326 (internal-format binary
// IO, x=lng / y=lat), SPATIAL index on NOT NULL columns, ST_Distance_Sphere
// for geoSearch and $geoWithin. Validated against MySQL 8 RDS.

const SF: [number, number] = [-122.42, 37.77];
const LA: [number, number] = [-118.24, 34.05];

let GeoPlace: any;
let GeoPlaceOpt: any;

function makeTable(Type: any, overrides?: Parameters<typeof createMockDriver>[0]) {
  const driver = createMockDriver(overrides);
  const adapter = new MysqlAdapter(driver);
  const table = new AtscriptDbTable(Type, adapter);
  return { driver, adapter, table };
}

describe("[mysql] geo support", () => {
  beforeAll(async () => {
    await prepareFixtures();
    ({ GeoPlace, GeoPlaceOpt } = await import("./fixtures/geo-table.as"));
  });

  // ── Binary codec ──────────────────────────────────────────────────────────

  it("encodes [lng, lat] as internal-format SRID 4326 WKB", () => {
    const buf = geoPointToMysqlInternal(SF);
    expect(buf.length).toBe(25);
    expect(buf.readUInt32LE(0)).toBe(4326); // SRID header
    expect(buf.readUInt8(4)).toBe(1); // little-endian
    expect(buf.readUInt32LE(5)).toBe(1); // point type
    expect(buf.readDoubleLE(9)).toBe(SF[0]); // x = lng
    expect(buf.readDoubleLE(17)).toBe(SF[1]); // y = lat
  });

  it("decodes driver {x, y} objects and raw internal buffers to [lng, lat]", () => {
    expect(mysqlGeoValueToPoint({ x: SF[0], y: SF[1] })).toEqual(SF);
    expect(mysqlGeoValueToPoint(geoPointToMysqlInternal(LA))).toEqual(LA);
    expect(mysqlGeoValueToPoint("nope")).toBeUndefined();
    expect(mysqlGeoValueToPoint({ center: SF, radius: 5 })).toBeUndefined();
  });

  // ── Schema ────────────────────────────────────────────────────────────────

  it("maps db.geoPoint to POINT SRID 4326 in CREATE TABLE", async () => {
    const { driver, table } = makeTable(GeoPlace);
    await table.ensureTable();
    const create = driver.calls.find((c) => c.sql.includes("CREATE TABLE"));
    expect(create!.sql).toContain("`geo` POINT SRID 4326 NOT NULL");
  });

  it("folds SRS_ID into introspected column types", async () => {
    const { adapter } = makeTable(GeoPlace, {
      allResult: [
        {
          COLUMN_NAME: "geo",
          COLUMN_TYPE: "point",
          IS_NULLABLE: "NO",
          COLUMN_KEY: "",
          COLUMN_DEFAULT: null,
          SRS_ID: 4326,
        },
      ],
    });
    const cols = await adapter.getExistingColumns();
    expect(cols[0].type).toBe("POINT SRID 4326");
  });

  it("creates a SPATIAL index for a required geo field", async () => {
    const { driver, table } = makeTable(GeoPlace);
    await table.syncIndexes();
    const spatial = driver.calls.find((c) => c.sql.includes("CREATE SPATIAL INDEX"));
    expect(spatial).toBeDefined();
    expect(spatial!.sql).toContain("(`geo`)");
  });

  it("skips the SPATIAL index with a warning for an optional geo field", async () => {
    const driver = createMockDriver();
    const warn = vi.fn();
    const space = new DbSpace(() => new MysqlAdapter(driver), {
      logger: { error: vi.fn(), warn, log: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
    });
    const table = space.getTable(GeoPlaceOpt) as any;
    await table.syncIndexes();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NOT NULL"));
    expect(driver.calls.some((c) => c.sql.includes("CREATE SPATIAL INDEX"))).toBe(false);
  });

  it("migrates a v1 JSON column to POINT via a temp column on type change", async () => {
    const { driver, adapter, table } = makeTable(GeoPlace);
    void table.fieldDescriptors;
    const geoField = table.fieldDescriptors.find((f: any) => f.path === "geo")!;
    await adapter.syncColumns({
      added: [],
      removed: [],
      typeChanged: [{ field: geoField, oldType: "JSON" }],
    } as any);
    const sqls = driver.calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes("ADD COLUMN `geo__geo_mig` POINT SRID 4326 NULL"))).toBe(
      true,
    );
    expect(
      sqls.some(
        (s) =>
          s.includes("SET `geo__geo_mig` = ST_SRID(POINT(CAST(`geo`->>'$[0]' AS DOUBLE)") &&
          s.includes("WHERE `geo` IS NOT NULL"),
      ),
    ).toBe(true);
    expect(sqls.some((s) => s.includes("DROP COLUMN `geo`"))).toBe(true);
    expect(sqls.some((s) => s.includes("RENAME COLUMN `geo__geo_mig` TO `geo`"))).toBe(true);
    expect(sqls.some((s) => s.includes("MODIFY COLUMN `geo` POINT SRID 4326 NOT NULL"))).toBe(true);
  });

  // ── Write/read path ───────────────────────────────────────────────────────

  it("insertOne sends the geo tuple as an internal-format Buffer param", async () => {
    const { driver, table } = makeTable(GeoPlace);
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    const insert = driver.calls.find((c) => c.sql.startsWith("INSERT INTO"));
    const buf = insert!.params!.find((p) => Buffer.isBuffer(p)) as Buffer;
    expect(buf).toBeDefined();
    expect(buf.readUInt32LE(0)).toBe(4326);
    expect(buf.readDoubleLE(9)).toBe(SF[0]);
  });

  it("reconstructs {x, y} reads back to the [lng, lat] tuple", async () => {
    const { table } = makeTable(GeoPlace, {
      getResult: { id: "sf", name: "SF", geo: { x: SF[0], y: SF[1] } },
    });
    const row = (await table.findOne({ filter: { id: "sf" }, controls: {} })) as any;
    expect(row.geo).toEqual(SF);
  });

  // ── Geo queries ───────────────────────────────────────────────────────────

  it("geoSearch builds an ST_Distance_Sphere ranked query and renames $distance", async () => {
    const { driver, table } = makeTable(GeoPlace, {
      allResult: [{ id: "sf", name: "SF", geo: { x: SF[0], y: SF[1] }, __atscript_distance: 0 }],
    });
    const rows = (await table.geoSearch(SF, {
      controls: { $maxDistance: 600_000, $limit: 5 },
    })) as any[];
    const search = driver.calls.find((c) => c.sql.includes("ST_Distance_Sphere"));
    expect(search!.sql).toContain("ST_Distance_Sphere(`geo`, ST_SRID(POINT(?, ?), 4326))");
    expect(search!.sql).toContain("`__atscript_distance` IS NOT NULL");
    expect(search!.sql).toContain("`__atscript_distance` <= ?");
    expect(search!.sql).toContain("ORDER BY `__atscript_distance` ASC LIMIT ?");
    expect(search!.params).toEqual([SF[0], SF[1], 600_000, 5]);
    expect(rows[0].$distance).toBe(0);
    expect(rows[0].geo).toEqual(SF);
  });

  it("$geoWithin translates to an ST_Distance_Sphere radius predicate", async () => {
    const { driver, table } = makeTable(GeoPlace);
    await table.findMany({
      filter: { geo: { $geoWithin: { center: SF, radius: 1000 } } },
      controls: {},
    });
    const select = driver.calls.find((c) => c.sql.startsWith("SELECT"));
    expect(select!.sql).toContain("ST_Distance_Sphere(`geo`, ST_SRID(POINT(?, ?), 4326)) <= ?");
    expect(select!.params).toEqual([SF[0], SF[1], 1000]);
  });
});
