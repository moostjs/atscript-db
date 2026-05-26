import { type AtscriptDbTable, DbSpace } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Real-Mongo regression for as-test bug
// `01-mongo-merge-subdoc-drops-leaf-on-full-rewrite`. Mirrors the failing HTTP
// flow at the table layer: insert → full-leaf merge PATCH → read back. The
// upstream `CollectionPatcher` standalone probe (PASSWORD_HASH_LOSS.md §4)
// passed because it omitted `ops`; the HTTP path injects the version
// auto-bump, which lands a computed expression in the same $set stage as the
// dotted-path literals and triggers the drop. Without the construction-rule
// fix in CollectionPatcher this spec fails on `password.hash`.

let PasswordDocFixture: any;

describe("MongoAdapter — @db.patch.strategy 'merge' subdoc, full-leaf rewrite", () => {
  let server: any;
  let client: MongoClient;
  let db: Db;
  let space: DbSpace;
  let docs: AtscriptDbTable;
  let docsAdapter: MongoAdapter;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/password-doc.as");
    PasswordDocFixture = fixtures.PasswordDocFixture;

    const { MongoMemoryServer } = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server = await MongoMemoryServer.create();
    client = new MC(server.getUri());
    await client.connect();
    db = client.db("test");
    space = new DbSpace(() => new MongoAdapter(db, client));
    docs = space.getTable(PasswordDocFixture);
    docsAdapter = space.getAdapter(PasswordDocFixture) as unknown as MongoAdapter;
  }, 60000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  beforeEach(async () => {
    try {
      await db.collection("password_docs").drop();
    } catch {
      /* not yet created */
    }
    docsAdapter.clearCollectionCache();
  });

  // Load-bearing regression: without the $literal wrap, `password.hash`
  // ("$scrypt$NEW") gets evaluated as a field path and the key is dropped.
  it("preserves $-prefixed leaves when patch rewrites every merge field", async () => {
    await docs.insertOne({
      id: 1,
      label: "repro-full",
      password: {
        hash: "$scrypt$OLD",
        history: [],
        lastChanged: 1000,
        isInitial: true,
      },
    } as any);

    const result = await docs.updateOne({
      id: 1,
      password: {
        hash: "$scrypt$NEW",
        history: ["$scrypt$OLD"],
        lastChanged: 2000,
        isInitial: false,
      },
    } as any);
    expect(result.matchedCount).toBe(1);

    const row = (await docs.findOne({ filter: { id: 1 }, controls: {} })) as any;
    expect(row.password.hash).toBe("$scrypt$NEW");
    expect(row.password.history).toEqual(["$scrypt$OLD"]);
    expect(row.password.lastChanged).toBe(2000);
    expect(row.password.isInitial).toBe(false);
    expect(row.label).toBe("repro-full"); // unrelated sibling preserved
    expect(row.version).toBe(1); // auto-bump still occurred
  });

  // Sanity case: a subset patch (only 2 dotted paths) never triggered the
  // bug — captured to lock both the failing and passing shapes from the
  // original report.
  it("preserves untouched leaves when patch covers only a subset", async () => {
    await docs.insertOne({
      id: 2,
      label: "repro-subset",
      password: {
        hash: "$scrypt$ORIG",
        history: ["old1", "old2"],
        lastChanged: 1000,
        isInitial: true,
      },
    } as any);

    await docs.updateOne({
      id: 2,
      password: { lastChanged: 9999, isInitial: false },
    } as any);

    const row = (await docs.findOne({ filter: { id: 2 }, controls: {} })) as any;
    expect(row.password.hash).toBe("$scrypt$ORIG");
    expect(row.password.history).toEqual(["old1", "old2"]);
    expect(row.password.lastChanged).toBe(9999);
    expect(row.password.isInitial).toBe(false);
  });

  // Two consecutive full-leaf rewrites — catches any per-call statefulness
  // in the patcher that would only surface on the second pass.
  it("preserves leaves across two consecutive full-leaf rewrites", async () => {
    await docs.insertOne({
      id: 3,
      label: "repro-twice",
      password: {
        hash: "$scrypt$V0",
        history: [],
        lastChanged: 1000,
        isInitial: true,
      },
    } as any);

    await docs.updateOne({
      id: 3,
      password: {
        hash: "$scrypt$V1",
        history: ["$scrypt$V0"],
        lastChanged: 2000,
        isInitial: false,
      },
    } as any);
    await docs.updateOne({
      id: 3,
      password: {
        hash: "$scrypt$V2",
        history: ["$scrypt$V0", "$scrypt$V1"],
        lastChanged: 3000,
        isInitial: false,
      },
    } as any);

    const row = (await docs.findOne({ filter: { id: 3 }, controls: {} })) as any;
    expect(row.password.hash).toBe("$scrypt$V2");
    expect(row.password.history).toEqual(["$scrypt$V0", "$scrypt$V1"]);
    expect(row.password.lastChanged).toBe(3000);
    expect(row.password.isInitial).toBe(false);
    expect(row.version).toBe(2);
  });
});
