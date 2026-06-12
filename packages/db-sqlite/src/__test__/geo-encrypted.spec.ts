import { randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// SQL adapters in v1 (geo-index spec §5.2): geo declarations stay portable —
// the same .as file syncs everywhere — but the index is skipped with a warning
// and geo queries fail loudly. Encrypted fields map to unbounded TEXT.

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

  it("skips the geo index with a warning (no index created, no drift churn)", async () => {
    await table.ensureTable();
    await table.syncIndexes();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("geo index"));
    const indexes = driver.all<{ name: string }>(`PRAGMA index_list("geo_enc_places")`);
    expect(indexes.some((i) => i.name.startsWith("atscript__geo"))).toBe(false);
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

  it("geoSearch fails loudly with GEO_NOT_SUPPORTED", async () => {
    await table.ensureTable();
    await expect(table.geoSearch([0, 0])).rejects.toMatchObject({ code: "GEO_NOT_SUPPORTED" });
  });

  it("$geoWithin fails loudly with GEO_NOT_SUPPORTED (never a silent scan)", async () => {
    await table.ensureTable();
    await expect(
      table.findMany({
        filter: { geo: { $geoWithin: { center: [0, 0], radius: 1000 } } },
        controls: {},
      }),
    ).rejects.toMatchObject({ code: "GEO_NOT_SUPPORTED" });
  });
});
