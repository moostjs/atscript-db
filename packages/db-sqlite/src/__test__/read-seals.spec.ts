import { randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.143: geo and vector search project `$select` exactly like
// findMany (inclusion + exclusion forms — the write-only seal HTTP layers
// pass is an exclusion projection), and views inherit read seals.

let fx: Record<string, any>;

let sqliteVecAvailable = true;
try {
  new BetterSqlite3Driver(":memory:", { vector: true }).close();
} catch {
  sqliteVecAvailable = false;
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/read-seals.as");
});

let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeEach(() => {
  driver = new BetterSqlite3Driver(":memory:", { vector: sqliteVecAvailable });
  space = new DbSpace(() => new SqliteAdapter(driver), {
    encryption: { defaultKeyId: "k1", keys: { k1: randomBytes(32) } },
  });
});

afterEach(() => {
  driver.close();
});

async function seedPlaces() {
  const places = space.getTable(fx.RsPlace);
  await places.ensureTable();
  await places.insertOne({
    id: "sf",
    name: "SF",
    pin: "1111",
    token: "tok-sf",
    settings: { theme: "dark", apiKey: "KEY-SF" },
    geo: [-122.42, 37.77],
  });
  await places.insertOne({
    id: "la",
    name: "LA",
    pin: "2222",
    token: "tok-la",
    settings: { theme: "light", apiKey: "KEY-LA" },
    geo: [-118.24, 34.05],
  });
  return places;
}

const SF: [number, number] = [-122.42, 37.77];

/** A 256-d unit vector on dimension `i`. */
const basis = (i: number) => Array.from({ length: 256 }, (_, k) => (k === i ? 1 : 0));

describe("[sqlite] geoSearch honours $select", () => {
  it("inclusion form returns only the selected fields plus $distance", async () => {
    const places = await seedPlaces();
    const rows = (await places.geoSearch(SF, { controls: { $select: ["id"] } })) as any[];
    expect(rows.map((r) => r.id)).toEqual(["sf", "la"]);
    expect(Object.keys(rows[0]).toSorted()).toEqual(["$distance", "id"]);
  });

  it("exclusion form (the write-only seal) drops the excluded columns only", async () => {
    const places = await seedPlaces();
    const rows = (await places.geoSearch(SF, {
      controls: { $select: { pin: 0, settings: 0 } },
    })) as any[];
    expect(rows[0]).not.toHaveProperty("pin");
    expect(rows[0]).not.toHaveProperty("settings");
    expect(rows[0]).toMatchObject({ id: "sf", name: "SF", token: "tok-sf", geo: SF });
    expect(rows[0].$distance).toBeCloseTo(0, 0);
  });

  it("a nested-object path selects its flattened leaves", async () => {
    const places = await seedPlaces();
    const rows = (await places.geoSearch(SF, {
      controls: { $select: ["id", "settings.theme"] },
    })) as any[];
    expect(rows[0]).toEqual({
      id: "sf",
      settings: { theme: "dark" },
      $distance: rows[0].$distance,
    });
  });

  it("geoSearchWithCount projects the page and still counts the window", async () => {
    const places = await seedPlaces();
    const result = (await places.geoSearchWithCount(SF, {
      controls: { $select: { pin: 0 }, $limit: 1 },
    })) as { data: any[]; count: number };
    expect(result.count).toBe(2);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).not.toHaveProperty("pin");
    expect(result.data[0].name).toBe("SF");
  });
});

describe.skipIf(!sqliteVecAvailable)("[sqlite] vectorSearch honours $select", () => {
  async function seedDocs() {
    const docs = space.getTable(fx.RsDoc);
    await docs.ensureTable();
    await docs.syncIndexes();
    await docs.insertOne({ id: "a", title: "A", pin: "1", category: "x", embedding: basis(0) });
    await docs.insertOne({ id: "b", title: "B", pin: "2", category: "y", embedding: basis(1) });
    return docs;
  }

  it("inclusion and exclusion forms, with and without a residual filter", async () => {
    const docs = await seedDocs();
    const inc = (await docs.vectorSearch(basis(0), {
      filter: {},
      controls: { $select: ["id"] },
    })) as any[];
    expect(inc[0].id).toBe("a");
    expect(inc[0]).not.toHaveProperty("pin");
    expect(inc[0]).not.toHaveProperty("title");

    // Residual (non-partition) filter on a column the projection drops.
    const exc = (await docs.vectorSearch(basis(0), {
      filter: { title: "B" },
      controls: { $select: { pin: 0 } },
    })) as any[];
    expect(exc.map((r) => r.id)).toEqual(["b"]);
    expect(exc[0]).not.toHaveProperty("pin");
    expect(exc[0].title).toBe("B");
  });

  it("vectorSearchWithCount projects the page", async () => {
    const docs = await seedDocs();
    const result = (await docs.vectorSearchWithCount(basis(0), {
      filter: {},
      controls: { $select: { pin: 0 } },
    })) as { data: any[]; count: number };
    expect(result.count).toBe(2);
    expect(result.data.every((r) => !("pin" in r))).toBe(true);
  });
});

describe("[sqlite] views inherit read seals", () => {
  it("a view column over an encrypted field reads decrypted and rejects filters", async () => {
    const sync = await new SchemaSync(space).run([fx.RsPlace, fx.RsPlaceView], { force: true });
    expect(sync.status).toBe("synced");
    await seedPlaces();
    const view = space.getView(fx.RsPlaceView);
    const rows = (await view.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];
    expect(rows.map((r) => r.token)).toEqual(["tok-la", "tok-sf"]);
    await expect(
      view.findMany({ filter: { token: "tok-la" }, controls: {} }),
    ).rejects.toMatchObject({ code: "ENC_FIELD_FILTER" });
  });

  it("a view column over a write-only field carries db.writeOnly for HTTP layers", () => {
    const view = space.getView(fx.RsPlaceView);
    expect(view.flatMap.get("pin")!.metadata.get("db.writeOnly")).toBe(true);
    expect(view.flatMap.get("name")!.metadata.has("db.writeOnly")).toBe(false);
  });
});
