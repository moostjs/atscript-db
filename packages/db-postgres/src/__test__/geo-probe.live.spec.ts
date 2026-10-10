import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { AtscriptDbTable, DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL with PostGIS available when one
// is reachable, skips otherwise (CI has no server). Override the server with
// `ATSCRIPT_PG_TEST_URL` (an admin connection; the spec creates and drops its
// own `geo_probe` database).
//
// A geo value binds by its COLUMN's physical type (since 0.1.151): a JSONB geo
// column created before PostGIS was installed keeps the JSON form in a process
// that never syncs; a geography column gets EWKT; a sync that migrates the
// column learns the new type without a probe on the write path.

const DB = "geo_probe";

const reachable = await pgReachable();

const SF: [number, number] = [-122.42, 37.77];
const LA: [number, number] = [-118.24, 34.05];

let GeoPlace: any;
let driver: PgDriver;
/** Geo probes sent through the pool (`pg_extension` lookups). */
let probes = 0;

const JSONB_DDL = `CREATE TABLE "geo_places" ("id" VARCHAR(255) PRIMARY KEY, "name" VARCHAR(255) NOT NULL, "geo" JSONB)`;
const GEOGRAPHY_DDL = `CREATE TABLE "geo_places" ("id" VARCHAR(255) PRIMARY KEY, "name" VARCHAR(255) NOT NULL, "geo" geography(Point,4326))`;

/** Recreates `geo_places` with `ddl` (provisioned "elsewhere"), PostGIS installed or not. */
async function provision(ddl: string, postgis: boolean): Promise<void> {
  await driver.exec(`DROP TABLE IF EXISTS "geo_places"`);
  await driver.exec(`DROP TABLE IF EXISTS "__atscript_control"`);
  if (!postgis) {
    await driver.exec("DROP EXTENSION IF EXISTS postgis");
  }
  await driver.exec(ddl);
  if (postgis) {
    // installed AFTER the table — the JSONB case is the drift under test
    await driver.exec("CREATE EXTENSION IF NOT EXISTS postgis");
  }
}

/** A table over a fresh adapter: this "process" never ran schema sync. */
const fresh = (): any => new AtscriptDbTable(GeoPlace, new PostgresAdapter(driver));

const columnType = async () =>
  (await driver.get<{ t: string }>(
    `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = '"geo_places"'::regclass AND attname = 'geo'`,
  ))!.t;

const expectPoint = (actual: unknown, expected: [number, number]) => {
  const p = actual as [number, number];
  expect(p[0]).toBeCloseTo(expected[0], 9);
  expect(p[1]).toBeCloseTo(expected[1], 9);
};

describe.skipIf(!reachable)("[postgres live] geo values bind by the column's type", () => {
  beforeAll(async () => {
    await prepareFixtures();
    ({ GeoPlace } = await import("./fixtures/geo-table.as"));
    driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
    const get = driver.get.bind(driver);
    driver.get = ((sql: string, params?: unknown[]) => {
      if (sql.includes("pg_extension")) probes++;
      return get(sql, params);
    }) as typeof driver.get;
  });

  afterAll(async () => {
    await driver?.close();
    await dropPgDatabase(DB);
  });

  it("JSONB column, PostGIS installed later, never synced: JSON writes, readable back", async () => {
    await provision(JSONB_DDL, true);
    const table = fresh();
    probes = 0;
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    await table.insertMany([
      { id: "la", name: "LA", geo: LA },
      { id: "none", name: "none" },
    ]);
    await table.updateOne({ id: "none", geo: SF });
    expect(probes).toBe(1);
    expect(await columnType()).toBe("jsonb");
    const raw = await driver.all<{ id: string; geo: unknown }>(
      `SELECT id, geo FROM "geo_places" ORDER BY id`,
    );
    expect(raw.map((r) => r.geo)).toEqual([LA, SF, SF]);
    expectPoint((await table.findOne({ filter: { id: "sf" }, controls: {} })).geo, SF);
    expectPoint((await table.findOne({ filter: { id: "la" }, controls: {} })).geo, LA);
    // PostGIS is there, so geo search is offered — the JSONB column itself cannot serve it
    expect(table.isGeoSearchable()).toBe(true);
  });

  it("geography column, never synced: EWKT writes, readable back, first geo search works", async () => {
    await provision(GEOGRAPHY_DDL, true);
    const table = fresh();
    probes = 0;
    // the first geo statement of the process is a search (no earlier statement taught PostGIS presence)
    expect(await table.geoSearch(SF, { controls: {} })).toEqual([]);
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    await table.insertMany([{ id: "la", name: "LA", geo: LA }]);
    expect(probes).toBe(1);
    expect(await columnType()).toBe("geography(Point,4326)");
    const text = await driver.get<{ wkt: string }>(
      `SELECT ST_AsText(geo) AS wkt FROM "geo_places" WHERE id = 'sf'`,
    );
    expect(text!.wkt).toBe("POINT(-122.42 37.77)");
    expectPoint((await table.findOne({ filter: { id: "la" }, controls: {} })).geo, LA);
    const near = await table.geoSearch(SF, { controls: { $maxDistance: 1000 } });
    expect(near.map((r: any) => r.id)).toEqual(["sf"]);
    const within = await table.findMany({
      filter: { geo: { $geoWithin: { center: LA, radius: 1000 } } },
      controls: {},
    });
    expect(within.map((r: any) => r.id)).toEqual(["la"]);
  });

  it("no PostGIS, never synced: JSON writes; geo search and $geoWithin refused", async () => {
    await provision(JSONB_DDL, false);
    const table = fresh();
    await table.insertOne({ id: "sf", name: "SF", geo: SF });
    expectPoint((await table.findOne({ filter: { id: "sf" }, controls: {} })).geo, SF);
    await expect(table.geoSearch(SF, { controls: {} })).rejects.toMatchObject({
      code: "GEO_NOT_SUPPORTED",
    });
    const other = fresh();
    await expect(
      other.findMany({
        filter: { geo: { $geoWithin: { center: SF, radius: 1000 } } },
        controls: {},
      }),
    ).rejects.toMatchObject({ code: "GEO_NOT_SUPPORTED" });
  });

  it("schema sync migrates the JSONB column; writes then bind EWKT without probing", async () => {
    await provision(JSONB_DDL, true);
    await fresh().insertOne({ id: "sf", name: "SF", geo: SF });
    const space = new DbSpace(() => new PostgresAdapter(driver));
    const result = await new SchemaSync(space).run([GeoPlace], { force: true });
    expect(result.status).toBe("synced");
    expect(await columnType()).toBe("geography(Point,4326)");
    const table = space.getTable(GeoPlace) as any;
    probes = 0;
    await table.insertOne({ id: "la", name: "LA", geo: LA });
    expect(probes).toBe(0);
    expectPoint((await table.findOne({ filter: { id: "sf" }, controls: {} })).geo, SF);
    expectPoint((await table.findOne({ filter: { id: "la" }, controls: {} })).geo, LA);
    const near = await table.geoSearch(SF, { controls: { $maxDistance: 1000 } });
    expect(near.map((r: any) => r.id)).toEqual(["sf"]);
  });
});
