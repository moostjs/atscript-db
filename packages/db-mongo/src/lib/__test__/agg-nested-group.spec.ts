import { AtscriptDbTable, DbSpace } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

let AggWidgets: any;

/**
 * `$groupBy` on a JSON / nested descendant (`metadata.clicks`) end-to-end.
 * On Mongo nested descendants are native dotted paths (and `/meta` advertises
 * them), so grouping by one must work — `$group` may not emit a dotted output
 * key, so the pipeline keys it positionally and `$project`s it back nested.
 */
describe("aggregate — $groupBy on a nested (dotted) path via MongoAdapter", () => {
  let server: any;
  let client: MongoClient;
  let db: Db;
  let widgets: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    AggWidgets = (await import("./fixtures/agg-nested.as")).AggWidgets;

    const { MongoMemoryServer } = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server = await MongoMemoryServer.create();
    client = new MC(server.getUri());
    await client.connect();
    db = client.db("test");
    widgets = new DbSpace(() => new MongoAdapter(db, client)).getTable(AggWidgets);

    await widgets.insertMany([
      { id: 1, name: "w1", category: "a", metadata: { clicks: 7, impressions: 70 } },
      { id: 2, name: "w2", category: "a", metadata: { clicks: 7, impressions: 10 } },
      { id: 3, name: "w3", category: "b", metadata: { clicks: 3, impressions: 30 } },
    ] as any);
  }, 60000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  it("returns the grouped key nested under its parent (same shape as a dotted $select)", async () => {
    const rows = await widgets.aggregate({
      filter: {},
      controls: {
        $groupBy: ["metadata.clicks"],
        $select: ["metadata.clicks", { $fn: "count", $field: "name", $as: "cnt" }] as any,
        $sort: { "metadata.clicks": 1 } as any,
      },
    });
    expect(rows).toEqual([
      { metadata: { clicks: 3 }, cnt: 1 },
      { metadata: { clicks: 7 }, cnt: 2 },
    ]);
  });

  it("$having filters on the aggregate alias and on the dotted grouped key", async () => {
    const byAlias = await widgets.aggregate({
      filter: {},
      controls: {
        $groupBy: ["metadata.clicks"],
        $select: ["metadata.clicks", { $fn: "count", $field: "*", $as: "cnt" }] as any,
        $having: { cnt: { $gt: 1 } } as any,
      },
    });
    expect(byAlias).toEqual([{ metadata: { clicks: 7 }, cnt: 2 }]);

    const byKey = await widgets.aggregate({
      filter: {},
      controls: {
        $groupBy: ["metadata.clicks"],
        $select: [
          "metadata.clicks",
          { $fn: "sum", $field: "metadata.impressions", $as: "imp" },
        ] as any,
        $having: { "metadata.clicks": { $lt: 5 } } as any,
      },
    });
    expect(byKey).toEqual([{ metadata: { clicks: 3 }, imp: 30 }]);
  });

  it("mixes a plain and a dotted group key", async () => {
    const rows = await widgets.aggregate({
      filter: {},
      controls: {
        $groupBy: ["category", "metadata.clicks"],
        $select: ["category", "metadata.clicks", { $fn: "count", $field: "*", $as: "cnt" }] as any,
        $sort: { category: 1 } as any,
      },
    });
    expect(rows).toEqual([
      { category: "a", metadata: { clicks: 7 }, cnt: 2 },
      { category: "b", metadata: { clicks: 3 }, cnt: 1 },
    ]);
  });

  it("$count returns the number of distinct nested-key groups", async () => {
    const rows = await widgets.aggregate({
      filter: {},
      controls: { $groupBy: ["metadata.clicks"], $count: true },
    });
    expect(rows).toEqual([{ count: 2 }]);
  });
});
