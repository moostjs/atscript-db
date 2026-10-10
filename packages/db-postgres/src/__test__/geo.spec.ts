import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { geoPointToEwkt, parseEwkbPointHex, PendingGeoPoint } from "../sql-builder";
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
      'ST_SetSRID(ST_MakePoint(("geo"::jsonb->>0)::float8, ("geo"::jsonb->>1)::float8), 4326)::geography',
    );
    expect(alter!.sql).toContain('WHEN "geo" IS NULL THEN NULL');
  });

  it("migrates the TEXT column of a `db.geoPoint | null` of the earlier union layout too", async () => {
    // `::jsonb` reads the JSON text; a JSONB column passes through unchanged
    const { driver, adapter, table } = makeTable(GeoPlace);
    await table.ensureTable();
    const geoField = table.fieldDescriptors.find((f: any) => f.path === "geo")!;
    await adapter.syncColumns({
      added: [],
      removed: [],
      typeChanged: [{ field: geoField, existingType: "TEXT" }],
    } as any);
    const alter = driver.calls.find((c) => c.sql.includes("ALTER COLUMN"));
    expect(alter!.sql).toContain('("geo"::jsonb->>0)::float8');
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

const isProbe = (c: { sql: string }) => c.sql.includes("pg_extension");
const lastInsert = (driver: { calls: Array<{ sql: string; params?: unknown[] }> }) =>
  driver.calls.findLast((c) => c.sql.startsWith("INSERT INTO"))!;
/** The catalog: PostGIS presence + the `geo` column's type (`null`: no such table). */
const catalog = (postgis: boolean, geoType: string | null) => ({
  getResult: (sql: string) =>
    sql.includes("pg_extension")
      ? { postgis, columns: geoType === null ? null : { geo: geoType } }
      : null,
});

// Schema sync never ran in this process (tables provisioned elsewhere): a geo
// value binds by its COLUMN's physical type, read from the catalog before the
// first statement binding one — a geography column gets EWKT, a JSONB column
// (created before PostGIS was installed) the JSON form, whatever the
// extension's presence says (since 0.1.151).
describe("[postgres] geo without schema sync in this process", () => {
  beforeAll(async () => {
    await prepareFixtures();
    ({ GeoPlace } = await import("./fixtures/geo-table.as"));
  });

  it("geography column: probes once (no DDL), then writes EWKT", async () => {
    const { driver, adapter, table } = makeTable(GeoPlace, catalog(true, "geography"));
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    const probeAt = driver.calls.findIndex(isProbe);
    const insertAt = driver.calls.findIndex((c) => c.sql.startsWith("INSERT INTO"));
    expect(probeAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThan(probeAt);
    expect(driver.calls[probeAt]!.params).toEqual(['"geo_places"', ["geo"]]);
    expect(driver.calls[insertAt]!.params).toContain("SRID=4326;POINT(-122.42 37.77)");
    expect(driver.calls.some((c) => c.sql.includes("CREATE EXTENSION"))).toBe(false);
    expect(adapter.isGeoSearchable()).toBe(true);

    await table.insertOne({ id: "la", name: "LA", geo: [-118.24, 34.05] });
    expect(driver.calls.filter(isProbe)).toHaveLength(1);
    expect(lastInsert(driver).params).toContain("SRID=4326;POINT(-118.24 34.05)");
  });

  it("a JSONB column with PostGIS installed later keeps getting the JSON form", async () => {
    const { driver, adapter, table } = makeTable(GeoPlace, catalog(true, "jsonb"));
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    expect(lastInsert(driver).params).toContain(JSON.stringify(SF));
    await table.insertOne({ id: "la", name: "LA", geo: [-118.24, 34.05] });
    expect(lastInsert(driver).params).toContain(JSON.stringify([-118.24, 34.05]));
    expect(driver.calls.filter(isProbe)).toHaveLength(1);
    // PostGIS itself is there: geo search stays available
    expect(adapter.isGeoSearchable()).toBe(true);
  });

  it("a geometry column (or a domain over one) takes EWKT too", async () => {
    const { driver, table } = makeTable(GeoPlace, catalog(true, "geometry"));
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    expect(lastInsert(driver).params).toContain("SRID=4326;POINT(-122.42 37.77)");
  });

  it("without PostGIS the JSON form goes out, as with a synced JSONB table", async () => {
    const { driver, adapter, table } = makeTable(GeoPlace, catalog(false, "jsonb"));
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    expect(lastInsert(driver).params).toContain(JSON.stringify(SF));
    expect(adapter.isGeoSearchable()).toBe(false);
    // presence is known now: later values never become markers, no probe
    await table.insertOne({ id: "la", name: "LA", geo: [-118.24, 34.05] });
    expect(driver.calls.filter(isProbe)).toHaveLength(1);
  });

  it("a table the catalog does not show follows PostGIS presence and is probed again", async () => {
    const { driver, table } = makeTable(GeoPlace, catalog(true, null));
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    expect(lastInsert(driver).params).toContain("SRID=4326;POINT(-122.42 37.77)");
    await table.insertOne({ id: "la", name: "LA", geo: [-118.24, 34.05] });
    expect(driver.calls.filter(isProbe)).toHaveLength(2);
  });

  it("a filter value on the geo column resolves the same way", async () => {
    const { driver, table } = makeTable(GeoPlace, catalog(true, "jsonb"));
    const formatted = table.dbAdapter
      .formatValue(table.fieldDescriptors.find((f: any) => f.path === "geo")!)!
      .toStorage(SF);
    await table.dbAdapter.findMany({ filter: { geo: formatted }, controls: {} });
    const select = driver.calls.findLast((c) => c.sql.startsWith("SELECT"))!;
    expect(select.params).toEqual([SF]);
  });

  it("a failed probe is not cached: the next statement probes again", async () => {
    let fail = true;
    const { driver, table } = makeTable(GeoPlace, {
      getResult: (sql: string) => {
        if (!sql.includes("pg_extension")) return null;
        if (fail) {
          fail = false;
          throw new Error("connection reset");
        }
        return { postgis: true, columns: { geo: "geography" } };
      },
    });
    await expect(table.insertOne({ id: "sf", name: "SF", geo: SF })).rejects.toThrow(
      "connection reset",
    );
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    expect(driver.calls.filter(isProbe)).toHaveLength(2);
    expect(lastInsert(driver).params).toContain("SRID=4326;POINT(-122.42 37.77)");
  });

  it("concurrent statements share one probe; a failed shared probe is retried by each joiner once", async () => {
    let probes = 0;
    const { driver, adapter } = makeTable(GeoPlace, {
      getResult: (sql: string) => {
        if (!sql.includes("pg_extension")) return null;
        probes++;
        if (probes === 1) throw new Error("current transaction is aborted");
        return { postgis: true, columns: { geo: "geography" } };
      },
    });
    const a = adapter as any;
    const pending = () =>
      a.formatValue(a._table.fieldDescriptors.find((f: any) => f.path === "geo")).toStorage(SF);
    const results = await Promise.allSettled([
      adapter.insertOne({ id: "a", name: "A", geo: pending() }),
      adapter.insertOne({ id: "b", name: "B", geo: pending() }),
      adapter.insertOne({ id: "c", name: "C", geo: pending() }),
    ]);
    // the starter fails with its own error; both joiners retry and succeed
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    const inserts = driver.calls.filter((c) => c.sql.startsWith("INSERT INTO"));
    expect(inserts).toHaveLength(2);
    for (const insert of inserts) {
      expect(insert.params).toContain("SRID=4326;POINT(-122.42 37.77)");
    }
  });

  it("a transaction does not wait on a probe running on the pool (no pool deadlock)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let probes = 0;
    const { driver, adapter } = makeTable(GeoPlace, {
      getResult: async (sql: string) => {
        if (!sql.includes("pg_extension")) return null;
        if (++probes === 1) await gate; // the pool's probe hangs (no free connection)
        return { postgis: true, columns: { geo: "geography" } };
      },
    });
    const a = adapter as any;
    const pending = () =>
      a.formatValue(a._table.fieldDescriptors.find((f: any) => f.path === "geo")).toStorage(SF);
    const onPool = adapter.insertOne({ id: "p", name: "P", geo: pending() });
    await adapter.withTransaction(async () => {
      await adapter.insertOne({ id: "t", name: "T", geo: pending() });
    });
    expect(probes).toBe(2);
    release();
    await onPool;
    expect(driver.calls.filter((c) => c.sql.startsWith("INSERT INTO"))).toHaveLength(2);
  });

  it("schema sync learns the column types (afterSyncTable): writes never probe after it", async () => {
    const { driver, table } = makeTable(GeoPlace, catalog(true, "geography"));
    await table.ensureTable();
    await table.dbAdapter.afterSyncTable!();
    const probes = driver.calls.filter(isProbe).length;
    expect(probes).toBe(1);
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    await table.insertOne({ id: "la", name: "LA", geo: [-118.24, 34.05] });
    expect(driver.calls.filter(isProbe)).toHaveLength(probes);
    expect(lastInsert(driver).params).toContain("SRID=4326;POINT(-118.24 34.05)");
  });

  it("DDL forgets the learned column types (a JSONB → geography migration)", async () => {
    let geoType = "jsonb";
    const { driver, adapter, table } = makeTable(GeoPlace, {
      getResult: (sql: string) =>
        sql.includes("pg_extension") ? { postgis: true, columns: { geo: geoType } } : null,
    });
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    expect(lastInsert(driver).params).toContain(JSON.stringify(SF));
    await table.ensureTable();
    const geoField = table.fieldDescriptors.find((f: any) => f.path === "geo")!;
    await adapter.syncColumns({
      added: [],
      removed: [],
      typeChanged: [{ field: geoField, existingType: "JSONB" }],
    } as any);
    geoType = "geography";
    await table.insertOne({ id: "la", name: "LA", geo: [-118.24, 34.05] });
    expect(lastInsert(driver).params).toContain("SRID=4326;POINT(-118.24 34.05)");
  });

  it("schema sync after a negative probe still installs PostGIS and maps geography", async () => {
    const { driver, table } = makeTable(GeoPlace, catalog(false, null));
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    await table.ensureTable();
    expect(driver.calls.some((c) => c.sql.includes("CREATE EXTENSION IF NOT EXISTS postgis"))).toBe(
      true,
    );
    expect(driver.calls.find((c) => c.sql.includes("CREATE TABLE"))!.sql).toContain(
      '"geo" geography(Point,4326)',
    );
  });

  it("a table without geo fields never probes", async () => {
    const { UsersTable } = await import("./fixtures/test-table.as");
    const { driver, table } = makeTable(UsersTable);
    await table.findMany({ filter: { name: "a" }, controls: {} });
    expect(driver.calls.some(isProbe)).toBe(false);
  });

  it("another table's marker (a relational filter) is resolved by the executing adapter", async () => {
    // One pool: the geo table never ran a statement; the users table executes
    // a statement carrying the geo table's marker (as a `$some` on a geo leaf does).
    const { UsersTable } = await import("./fixtures/test-table.as");
    const driver = createMockDriver(catalog(true, "geography"));
    const geoTable = new AtscriptDbTable(GeoPlace, new PostgresAdapter(driver)) as any;
    const users = new AtscriptDbTable(UsersTable, new PostgresAdapter(driver)) as any;
    const marker = geoTable.dbAdapter
      .formatValue(geoTable.fieldDescriptors.find((f: any) => f.path === "geo"))
      .toStorage(SF);
    expect(marker).toBeInstanceOf(PendingGeoPoint);
    await users.dbAdapter.findMany({ filter: { name: marker }, controls: {} });
    const select = driver.calls.findLast((c) => c.sql.startsWith("SELECT"))!;
    expect(select.params).toEqual(["SRID=4326;POINT(-122.42 37.77)"]);
    // the probe asked about the GEO table's column
    expect(driver.calls.find(isProbe)!.params).toEqual(['"geo_places"', ["geo"]]);
  });

  it("the first geo search of a process that never syncs is not refused up front", async () => {
    const { driver, table } = makeTable(GeoPlace, {
      ...catalog(true, "geography"),
      allResult: [{ id: "sf", name: "SF", geo: SF_EWKB_HEX, __atscript_distance: 0 }],
    });
    const rows = await table.geoSearch(SF, { controls: { $limit: 5 } });
    expect(rows).toHaveLength(1);
    expect(driver.calls.findIndex(isProbe)).toBeLessThan(
      driver.calls.findIndex((c) => c.sql.includes("ST_Distance(")),
    );
  });

  it("without PostGIS the first geo search / $geoWithin is refused with GEO_NOT_SUPPORTED", async () => {
    const first = makeTable(GeoPlace, catalog(false, "jsonb"));
    await expect(first.table.geoSearch(SF, { controls: {} })).rejects.toMatchObject({
      code: "GEO_NOT_SUPPORTED",
    });
    expect(first.table.dbAdapter.isGeoSearchable()).toBe(false);

    const second = makeTable(GeoPlace, catalog(false, "jsonb"));
    await expect(
      second.table.findMany({
        filter: { geo: { $geoWithin: { center: SF, radius: 1000 } } },
        controls: {},
      }),
    ).rejects.toMatchObject({ code: "GEO_NOT_SUPPORTED" });
    expect(second.driver.calls.some((c) => c.sql.includes("ST_DWithin("))).toBe(false);
  });
});
