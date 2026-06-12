import { randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// SQLite geo posture (phase 2): geoPoint tuples stay JSON TEXT, geoSearch and
// $geoWithin run a haversine scan (SQLite math functions), and declared geo
// indexes have no physical artifact. Encrypted fields map to unbounded TEXT.

let GeoEncPlace: any;

const ENVELOPE_RE = /^aes1\$[\w.-]+\$[\w-]+\$[\w-]+\$[\w-]+$/;

describe("[sqlite] @db.encrypted + @db.index.geo (v1 posture)", () => {
  let driver: BetterSqlite3Driver;
  let space: DbSpace;
  let table: any;
  let warn: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    await prepareFixtures();
    ({ GeoEncPlace } = await import("./fixtures/geo-encrypted.as"));
  });

  beforeEach(() => {
    driver = new BetterSqlite3Driver(":memory:");
    warn = vi.fn();
    const logger = { error: vi.fn(), warn, log: vi.fn(), info: vi.fn(), debug: vi.fn() };
    space = new DbSpace(() => new SqliteAdapter(driver), {
      logger: logger as any,
      encryption: { defaultKeyId: "k1", keys: { k1: randomBytes(32) } },
    });
    table = space.getTable(GeoEncPlace);
  });

  afterEach(() => {
    driver.close();
  });

  it("maps encrypted fields to TEXT columns (nested object → single column)", async () => {
    await table.ensureTable();
    const columns = driver.all<{ name: string; type: string }>(
      `PRAGMA table_info("geo_enc_places")`,
    );
    const byName = new Map(columns.map((c) => [c.name, c.type]));
    expect(byName.get("apiToken")).toBe("TEXT");
    expect(byName.get("credentials")).toBe("TEXT");
    // No flattened child columns for the encrypted object
    expect(byName.has("credentials__user")).toBe(false);
  });

  it("creates no physical geo index (haversine is scan-based, no drift churn)", async () => {
    await table.ensureTable();
    await table.syncIndexes();
    const indexes = driver.all<{ name: string }>(`PRAGMA index_list("geo_enc_places")`);
    expect(indexes.some((i) => i.name.startsWith("atscript__geo"))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stores envelopes at rest and decrypts on read (full sqlite round-trip)", async () => {
    await table.ensureTable();
    await table.syncIndexes();
    await table.insertOne({
      id: "p1",
      name: "Place",
      geo: [-122.42, 37.77],
      apiToken: "secret-token",
      credentials: { user: "u", pwd: "p" },
    });

    const raw = driver.all(`SELECT * FROM "geo_enc_places"`)[0]!;
    expect(raw.apiToken).toMatch(ENVELOPE_RE);
    expect(raw.credentials).toMatch(ENVELOPE_RE);
    expect(JSON.stringify(raw)).not.toContain("secret-token");

    const row = await table.findOne({ filter: { id: "p1" }, controls: {} });
    expect(row.apiToken).toBe("secret-token");
    expect(row.credentials).toEqual({ user: "u", pwd: "p" });
    expect(row.geo).toEqual([-122.42, 37.77]);
  });

  it("geoSearch returns distance-ranked rows with $distance (haversine)", async () => {
    await table.ensureTable();
    // SF, LA, NYC — query from SF
    await table.insertOne({ id: "sf", name: "SF", geo: [-122.42, 37.77], apiToken: "t" });
    await table.insertOne({ id: "la", name: "LA", geo: [-118.24, 34.05], apiToken: "t" });
    await table.insertOne({ id: "nyc", name: "NYC", geo: [-74.006, 40.71], apiToken: "t" });
    await table.insertOne({ id: "nowhere", name: "no geo", apiToken: "t" });

    const rows = await table.geoSearch([-122.42, 37.77]);
    expect(rows.map((r: any) => r.id)).toEqual(["sf", "la", "nyc"]);
    expect(rows[0].$distance).toBeCloseTo(0, 0);
    // SF→LA great-circle ≈ 559 km; haversine on a sphere within ~1%
    expect(rows[1].$distance).toBeGreaterThan(550_000);
    expect(rows[1].$distance).toBeLessThan(570_000);
    // geo tuple round-trips alongside the computed distance
    expect(rows[1].geo).toEqual([-118.24, 34.05]);
  });

  it("$geoWithin filters by haversine circle (no silent full scan semantics)", async () => {
    await table.ensureTable();
    await table.insertOne({ id: "sf", name: "SF", geo: [-122.42, 37.77], apiToken: "t" });
    await table.insertOne({ id: "la", name: "LA", geo: [-118.24, 34.05], apiToken: "t" });
    await table.insertOne({ id: "nowhere", name: "no geo", apiToken: "t" });

    const rows = await table.findMany({
      filter: { geo: { $geoWithin: { center: [-122.42, 37.77], radius: 600_000 } } },
      controls: {},
    });
    expect(rows.map((r: any) => r.id).toSorted()).toEqual(["la", "sf"]);
  });

  it("geoSearchWithCount honors $maxDistance and counts the window", async () => {
    await table.ensureTable();
    await table.insertOne({ id: "sf", name: "SF", geo: [-122.42, 37.77], apiToken: "t" });
    await table.insertOne({ id: "la", name: "LA", geo: [-118.24, 34.05], apiToken: "t" });
    await table.insertOne({ id: "nyc", name: "NYC", geo: [-74.006, 40.71], apiToken: "t" });

    const result = await table.geoSearchWithCount([-122.42, 37.77], {
      controls: { $maxDistance: 600_000, $limit: 1 },
    });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe("sf");
    expect(result.count).toBe(2);
  });
});
