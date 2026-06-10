import { randomBytes } from "node:crypto";

import { AtscriptDbTable, DbSpace } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// End-to-end against a real mongod (mongodb-memory-server): 2dsphere +
// $geoNear work fully in-memory — no Atlas needed (geo-index spec §8) —
// and the encryption envelope round-trips through the native driver and
// CollectionPatcher aggregation $set (field-encryption spec §11.8).

let GeoListing: any;
let EncSecret: any;

const ENVELOPE_RE = /^aes1\$[\w.-]+\$[\w-]+\$[\w-]+\$[\w-]+$/;

// Points east of [0, 0] with well-known great-circle distances:
// 0.01° lng at the equator ≈ 1113 m.
const CENTER: [number, number] = [0, 0];
const NEAR: [number, number] = [0.01, 0]; // ~1113 m
const MID: [number, number] = [0.02, 0]; // ~2226 m
const FAR: [number, number] = [0.05, 0]; // ~5565 m

describe("[mongo e2e] geo + encryption against a real mongod", () => {
  let server: any;
  let client: MongoClient;
  let db: Db;
  let space: DbSpace;
  let listings: AtscriptDbTable;
  let secrets: AtscriptDbTable;
  let listingsAdapter: MongoAdapter;
  let secretsAdapter: MongoAdapter;

  beforeAll(async () => {
    await prepareFixtures();
    ({ GeoListing, EncSecret } = await import("./fixtures/geo-collection.as"));

    const { MongoMemoryServer } = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server = await MongoMemoryServer.create();
    client = new MC(server.getUri());
    await client.connect();
    db = client.db("test");
    space = new DbSpace(() => new MongoAdapter(db, client), {
      encryption: { defaultKeyId: "k1", keys: { k1: randomBytes(32) } },
    });
    listings = space.getTable(GeoListing);
    secrets = space.getTable(EncSecret);
    listingsAdapter = space.getAdapter(GeoListing) as unknown as MongoAdapter;
    secretsAdapter = space.getAdapter(EncSecret) as unknown as MongoAdapter;
  }, 60_000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  beforeEach(async () => {
    for (const name of ["geo_listings", "enc_secrets"]) {
      try {
        await db.collection(name).drop();
      } catch {
        /* not yet created */
      }
    }
    listingsAdapter.clearCollectionCache();
    secretsAdapter.clearCollectionCache();
    await listings.syncIndexes();
  });

  async function seedListings() {
    await listings.insertMany([
      { id: "near", status: "ACTIVE", geo: NEAR },
      { id: "mid", status: "ACTIVE", geo: MID },
      { id: "far", status: "INACTIVE", geo: FAR },
    ]);
  }

  it("stores geo points as GeoJSON (raw driver) and reads back the tuple", async () => {
    await listings.insertOne({ id: "rt", status: "ACTIVE", geo: [-122.42, 37.77] });

    const raw = await db.collection("geo_listings").findOne({ id: "rt" });
    expect(raw!.geo).toEqual({ type: "Point", coordinates: [-122.42, 37.77] });

    const row = (await listings.findOne({ filter: { id: "rt" }, controls: {} })) as any;
    expect(row.geo).toEqual([-122.42, 37.77]);
  });

  it("creates the managed 2dsphere index", async () => {
    const indexes = await db.collection("geo_listings").indexes();
    const geoIndex = indexes.find((i) => i.name === "atscript__geo__geo");
    expect(geoIndex).toBeDefined();
    expect(geoIndex!.key).toEqual({ geo: "2dsphere" });
  });

  it("geoSearch returns distance-ordered rows with $distance (±0.5%)", async () => {
    await seedListings();
    const rows = (await listings.geoSearch(CENTER)) as any[];
    expect(rows.map((r) => r.id)).toEqual(["near", "mid", "far"]);
    expect(rows[0].$distance).toBeGreaterThan(1113 * 0.995);
    expect(rows[0].$distance).toBeLessThan(1113 * 1.005);
    expect(rows[1].$distance).toBeGreaterThan(2226 * 0.995);
    expect(rows[1].$distance).toBeLessThan(2226 * 1.005);
    // Geo points come back as tuples even through the aggregation path.
    expect(rows[0].geo).toEqual(NEAR);
  });

  it("honors $maxDistance / $minDistance windows and filter composition", async () => {
    await seedListings();
    const withinThree = (await listings.geoSearch(CENTER, {
      filter: {},
      controls: { $maxDistance: 3000 } as any,
    })) as any[];
    expect(withinThree.map((r) => r.id)).toEqual(["near", "mid"]);

    const ring = (await listings.geoSearch(CENTER, {
      filter: {},
      controls: { $minDistance: 1500, $maxDistance: 3000 } as any,
    })) as any[];
    expect(ring.map((r) => r.id)).toEqual(["mid"]);

    const active = (await listings.geoSearch(CENTER, {
      filter: { status: "ACTIVE" },
      controls: {} as any,
    })) as any[];
    expect(active.map((r) => r.id)).toEqual(["near", "mid"]);
  });

  it("geoSearchWithCount counts the full distance window across pages", async () => {
    await seedListings();
    const page = await listings.geoSearchWithCount(CENTER, {
      filter: {},
      controls: { $limit: 1 } as any,
    });
    expect(page.count).toBe(3);
    expect(page.data.map((r: any) => r.id)).toEqual(["near"]);
  });

  it("$geoWithin works as a pure predicate in findMany (no $distance, no sort)", async () => {
    await seedListings();
    const rows = (await listings.findMany({
      filter: { geo: { $geoWithin: { center: CENTER, radius: 3000 } } } as any,
      controls: {},
    })) as any[];
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(["near", "mid"]));
    expect(rows[0].$distance).toBeUndefined();
  });

  it("encrypts at rest (raw driver sees envelopes) and decrypts transparently", async () => {
    await secrets.insertOne({
      id: "s1",
      label: "prod",
      apiToken: "tok-123",
      credentials: { user: "u", pwd: "p" },
    });

    const raw = await db.collection("enc_secrets").findOne({ id: "s1" });
    expect(raw!.apiToken).toMatch(ENVELOPE_RE);
    expect(raw!.credentials).toMatch(ENVELOPE_RE);
    expect(JSON.stringify(raw)).not.toContain("tok-123");

    const row = (await secrets.findOne({ filter: { id: "s1" }, controls: {} })) as any;
    expect(row.apiToken).toBe("tok-123");
    expect(row.credentials).toEqual({ user: "u", pwd: "p" });
  });

  it("envelope survives CollectionPatcher aggregation $set (native patch path)", async () => {
    await secrets.insertOne({ id: "s2", label: "stage", apiToken: "old" });
    await secrets.updateOne({ id: "s2", apiToken: "new-token" });

    const raw = await db.collection("enc_secrets").findOne({ id: "s2" });
    expect(raw!.apiToken).toMatch(ENVELOPE_RE);

    const row = (await secrets.findOne({ filter: { id: "s2" }, controls: {} })) as any;
    expect(row.apiToken).toBe("new-token");
    expect(row.label).toBe("stage");
  });
});
