import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { geoPointToEwkt, parseEwkbPointHex } from "../sql-builder";
import type { TPgDriver } from "../types";
import { createMockDriver, prepareFixtures } from "./test-utils";

// PostgreSQL geo (phase 2): db.geoPoint → geography(Point,4326) when PostGIS
// is available (CREATE EXTENSION probe), JSONB fallback otherwise. EWKT text
// params in, hex-EWKB parsed out. Validated against PostGIS on RDS.

const SF: [number, number] = [-122.42, 37.77];
// Raw wire value captured from a real PostGIS read of the SF point
const SF_EWKB_HEX = "0101000020E61000007B14AE47E19A5EC0C3F5285C8FE24240";

let GeoPlace: any;

function makeTable(Type: any, overrides?: Parameters<typeof createMockDriver>[0]) {
  const driver = createMockDriver(overrides);
  const adapter = new PostgresAdapter(driver);
  const table = new AtscriptDbTable(Type, adapter);
  return { driver, adapter, table };
}

/** Wraps the mock driver so CREATE EXTENSION postgis fails (no PostGIS). */
function withoutPostgis(driver: TPgDriver & { calls: unknown[] }): TPgDriver {
  const exec = driver.exec.bind(driver);
  driver.exec = async (sql: string) => {
    if (sql.includes("postgis")) {
      throw new Error('extension "postgis" is not available');
    }
    return exec(sql);
  };
  return driver;
}

describe("[postgres] geo support", () => {
  beforeAll(async () => {
    await prepareFixtures();
    ({ GeoPlace } = await import("./fixtures/geo-table.as"));
  });

  // ── Codec ─────────────────────────────────────────────────────────────────

  it("formats tuples as EWKT and parses hex-EWKB reads back", () => {
    expect(geoPointToEwkt(SF)).toBe("SRID=4326;POINT(-122.42 37.77)");
    const point = parseEwkbPointHex(SF_EWKB_HEX)!;
    expect(point[0]).toBeCloseTo(SF[0], 10);
    expect(point[1]).toBeCloseTo(SF[1], 10);
    // Non-WKB strings pass through as undefined
    expect(parseEwkbPointHex("not-hex")).toBeUndefined();
    expect(parseEwkbPointHex("00")).toBeUndefined();
  });

  // ── Schema ────────────────────────────────────────────────────────────────

  it("maps db.geoPoint to geography(Point,4326) when PostGIS is available", async () => {
    const { driver, table } = makeTable(GeoPlace);
    await table.ensureTable();
    expect(driver.calls.some((c) => c.sql.includes("CREATE EXTENSION IF NOT EXISTS postgis"))).toBe(
      true,
    );
    const create = driver.calls.find((c) => c.sql.includes("CREATE TABLE"));
    expect(create!.sql).toContain('"geo" geography(Point,4326)');
  });

  it("falls back to JSONB (and disables geo search) without PostGIS", async () => {
    const { driver, adapter, table } = makeTable(GeoPlace);
    withoutPostgis(driver);
    await table.ensureTable();
    const create = driver.calls.find((c) => c.sql.includes("CREATE TABLE"));
    expect(create!.sql).toContain('"geo" JSONB');
    expect(adapter.isGeoSearchable()).toBe(false);
    await expect(adapter.geoSearch(SF, { filter: {}, controls: {} })).rejects.toMatchObject({
      code: "GEO_NOT_SUPPORTED",
    });
  });

  it("creates a GiST index for the geo field", async () => {
    const { driver, table } = makeTable(GeoPlace);
    await table.syncIndexes();
    const gist = driver.calls.find((c) => c.sql.includes("USING gist"));
    expect(gist).toBeDefined();
    expect(gist!.sql).toContain('("geo")');
  });

  it("migrates a v1 JSONB column to geography via ALTER ... USING on type change", async () => {
    const { driver, adapter, table } = makeTable(GeoPlace);
    await table.ensureTable(); // resolves PostGIS support
    const geoField = table.fieldDescriptors.find((f: any) => f.path === "geo")!;
    await adapter.syncColumns({
      added: [],
      removed: [],
      typeChanged: [{ field: geoField, oldType: "JSONB" }],
    } as any);
    const alter = driver.calls.find((c) => c.sql.includes("ALTER COLUMN"));
    expect(alter!.sql).toContain("TYPE geography(Point,4326)");
    expect(alter!.sql).toContain(
      'ST_SetSRID(ST_MakePoint(("geo"->>0)::float8, ("geo"->>1)::float8), 4326)::geography',
    );
    expect(alter!.sql).toContain('WHEN "geo" IS NULL THEN NULL');
  });

  // ── Write/read path ───────────────────────────────────────────────────────

  it("insertOne sends the geo tuple as an EWKT text param", async () => {
    const { driver, table } = makeTable(GeoPlace);
    await table.ensureTable();
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    const insert = driver.calls.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert!.params).toContain("SRID=4326;POINT(-122.42 37.77)");
  });

  it("reconstructs hex-EWKB reads back to the [lng, lat] tuple", async () => {
    const { table } = makeTable(GeoPlace, {
      getResult: { id: "sf", name: "SF", geo: SF_EWKB_HEX },
    });
    await table.ensureTable();
    const row = (await table.findOne({ filter: { id: "sf" }, controls: {} })) as any;
    expect(row.geo[0]).toBeCloseTo(SF[0], 10);
    expect(row.geo[1]).toBeCloseTo(SF[1], 10);
  });

  // ── Geo queries ───────────────────────────────────────────────────────────

  it("geoSearch builds an ST_Distance ranked query with $N params and renames $distance", async () => {
    const { driver, table } = makeTable(GeoPlace, {
      allResult: [{ id: "sf", name: "SF", geo: SF_EWKB_HEX, __atscript_distance: 0 }],
    });
    await table.ensureTable();
    const rows = await table.geoSearch(SF, { controls: { $maxDistance: 600_000, $limit: 5 } });
    const search = driver.calls.find((c) => c.sql.includes("ST_Distance("));
    expect(search!.sql).toContain(
      'ST_Distance("geo", ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)',
    );
    expect(search!.sql).toContain('"__atscript_distance" <= $3');
    expect(search!.sql).toContain('ORDER BY "__atscript_distance" ASC LIMIT $4');
    expect(search!.params).toEqual([SF[0], SF[1], 600_000, 5]);
    expect(rows[0].$distance).toBe(0);
  });

  it("$geoWithin translates to ST_DWithin", async () => {
    const { driver, table } = makeTable(GeoPlace);
    await table.ensureTable();
    await table.findMany({
      filter: { geo: { $geoWithin: { center: SF, radius: 1000 } } },
      controls: {},
    });
    const select = driver.calls.find(
      (c) => c.sql.startsWith("SELECT") && c.sql.includes("ST_DWithin"),
    );
    expect(select!.sql).toContain(
      'ST_DWithin("geo", ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)',
    );
    expect(select!.params).toEqual([SF[0], SF[1], 1000]);
  });

  it("geoSearchWithCount issues a windowed count alongside the data query", async () => {
    const { driver, table } = makeTable(GeoPlace, {
      allResult: [],
      getResult: { cnt: "2" },
    });
    await table.ensureTable();
    const result = await table.geoSearchWithCount(SF, { controls: { $maxDistance: 600_000 } });
    const count = driver.calls.find((c) => c.sql.includes("COUNT(*)"));
    expect(count!.sql).toContain('"__atscript_distance" IS NOT NULL');
    expect(count!.sql).toContain('"__atscript_distance" <= $3');
    expect(result.count).toBe(2);
  });
});
