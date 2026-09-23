import { AtscriptDbTable, DbSpace } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

let ExistsDoc: any;

/**
 * `$exists` on a real engine (since 0.1.132): "the field holds a value".
 * SQL adapters compile it to `IS [NOT] NULL`, which cannot tell a NULL column
 * from a missing one, so a stored `null` must count as ABSENT here too —
 * native Mongo `$exists` (key presence) would put a null-valued document on
 * the `true` side and diverge from every other adapter.
 */
describe("$exists null-model parity via MongoAdapter + AtscriptDbTable", () => {
  let server: any;
  let client: MongoClient;
  let db: Db;
  let docs: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ExistsDoc = (await import("./fixtures/exists-null.as")).ExistsDoc;
    const { MongoMemoryServer } = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server = await MongoMemoryServer.create();
    client = new MC(server.getUri());
    await client.connect();
    db = client.db("test");
    const space = new DbSpace(() => new MongoAdapter(db, client));
    docs = space.getTable(ExistsDoc);
    await docs.insertMany([
      { id: 1, label: "object", metrics: { value: 1 }, tags: ["a"], note: "x" },
      { id: 2, label: "empty", metrics: {}, tags: [], note: "" },
      { id: 3, label: "null", metrics: null, tags: null, note: null },
      { id: 4, label: "absent" },
    ] as any);
  }, 60000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  const ids = async (filter: Record<string, unknown>) =>
    (
      (await docs.findMany({ filter, controls: { $sort: { id: 1 } } } as any)) as Array<{
        id: number;
      }>
    ).map((r) => r.id);

  it("stores explicit null as a null-valued key and absent as a missing key (the divergence source)", async () => {
    const raw = await db.collection("exists_docs").find({}).toArray();
    const byLabel = new Map(raw.map((d) => [d.label as string, d]));
    expect("metrics" in byLabel.get("null")!).toBe(true);
    expect(byLabel.get("null")!.metrics).toBeNull();
    expect("metrics" in byLabel.get("absent")!).toBe(false);
  });

  it.each(["metrics", "tags", "note"])(
    "%s: $exists true = holds a value ({} / [] / '' included), false = null or missing",
    async (field) => {
      expect(await ids({ [field]: { $exists: true } })).toEqual([1, 2]);
      expect(await ids({ [field]: { $exists: false } })).toEqual([3, 4]);
      expect(await docs.count({ filter: { [field]: { $exists: true } } } as any)).toBe(2);
    },
  );

  it("composes with $not / $or / $and exactly like its complement", async () => {
    expect(await ids({ $not: { metrics: { $exists: true } } })).toEqual([3, 4]);
    expect(await ids({ $or: [{ metrics: { $exists: false } }, { label: "object" }] })).toEqual([
      1, 3, 4,
    ]);
    expect(
      await ids({ $and: [{ metrics: { $exists: true } }, { tags: { $exists: true } }] }),
    ).toEqual([1, 2]);
  });
});
