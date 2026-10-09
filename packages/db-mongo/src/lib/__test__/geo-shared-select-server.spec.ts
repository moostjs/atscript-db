import { DbSpace } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// A `$select` map the caller shares across queries reaches the adapter as is
// (`asProjection` returns the raw map when no path is renamed) — moost-db
// memoizes the projection of a read without `$select` (a model with write-only
// fields) and deep-freezes it in dev / test. The geo search must add its
// distance field to a copy: writing it into the shared map threw "Cannot add
// property __atscript_distance, object is not extensible" (frozen), or leaked
// the internal field into every later query using that map.

let replSet: any;
let client: MongoClient;
let db: Db;
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/geo-collection.as");
  const { MongoMemoryReplSet } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
    instanceOpts: [{ launchTimeout: 60_000 }],
  });
  client = new MC(replSet.getUri());
  await client.connect();
  db = client.db("geo_shared_select");
  await db.dropDatabase();
}, 120_000);

afterAll(async () => {
  if (client) await client.close();
  if (replSet) await replSet.stop();
});

describe("[mongo] geo search with a shared (frozen) inclusion $select", () => {
  it("returns $distance and leaves the caller's map untouched, query after query", async () => {
    const space = new DbSpace(() => new MongoAdapter(db, client));
    const listings = space.getTable(fx.GeoListing) as any;
    await listings.syncIndexes();
    await listings.insertMany([
      { id: "near", status: "open", geo: [0, 0.01] },
      { id: "far", status: "open", geo: [0, 0.03] },
      { id: "out", status: "closed", geo: [10, 10] },
    ]);

    const shared = Object.freeze({ id: 1, status: 1 });
    const query = () => ({
      filter: { status: "open" },
      controls: { $select: shared, $maxDistance: 10_000 },
    });

    for (let i = 0; i < 2; i++) {
      const rows = await listings.geoSearch([0, 0], query());
      expect(rows.map((r: any) => [r.id, r.status, typeof r.$distance])).toEqual([
        ["near", "open", "number"],
        ["far", "open", "number"],
      ]);
      expect(rows[0]).not.toHaveProperty("geo");
      expect(rows[0]).not.toHaveProperty("__atscript_distance");

      const page = await listings.geoSearchWithCount([0, 0], query());
      expect(page.count).toBe(2);
      expect(page.data.map((r: any) => [r.id, typeof r.$distance])).toEqual([
        ["near", "number"],
        ["far", "number"],
      ]);
    }
    expect(shared).toEqual({ id: 1, status: 1 });
  });
});
