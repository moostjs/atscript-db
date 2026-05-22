import { AtscriptDbTable, DbError, DbSpace } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Populated after fixtures compile.
let VersionedUserTable: any;
let PlainWidgetTable: any;

describe("OCC ($cas + auto-bump) end-to-end via MongoAdapter + AtscriptDbTable", () => {
  let server: any;
  let client: MongoClient;
  let db: Db;
  let space: DbSpace;
  let users: AtscriptDbTable;
  let widgets: AtscriptDbTable;
  let usersAdapter: MongoAdapter;
  let widgetsAdapter: MongoAdapter;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/version-occ.as");
    VersionedUserTable = fixtures.VersionedUserTable;
    PlainWidgetTable = fixtures.PlainWidgetTable;

    const { MongoMemoryServer } = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server = await MongoMemoryServer.create();
    client = new MC(server.getUri());
    await client.connect();
    db = client.db("test");
    space = new DbSpace(() => new MongoAdapter(db, client));
    users = space.getTable(VersionedUserTable);
    widgets = space.getTable(PlainWidgetTable);
    usersAdapter = space.getAdapter(VersionedUserTable) as unknown as MongoAdapter;
    widgetsAdapter = space.getAdapter(PlainWidgetTable) as unknown as MongoAdapter;
  }, 60000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  beforeEach(async () => {
    // Drop the underlying mongo collections between tests (collection name is
    // taken from @db.table, not the export name).
    for (const name of ["versioned_users", "plain_widgets"]) {
      try {
        await db.collection(name).drop();
      } catch {
        /* not yet created */
      }
    }
    usersAdapter.clearCollectionCache();
    widgetsAdapter.clearCollectionCache();
  });

  // WHY: §4.6 — versioned columns are server-managed. Mongo has no DDL
  // DEFAULT, so the adapter fills version=0 at insert time when missing.
  // Confirms the default is wired end-to-end through the table layer
  // (caller never has to know the bookkeeping column exists).
  it("default initializes version to 0 on insert", async () => {
    await users.insertOne({ id: 1, name: "Ada", status: "active", counter: 0 } as any);
    const row = (await users.findOne({ filter: { id: 1 }, controls: {} })) as any;
    expect(row.version).toBe(0);
  });

  // WHY: §4.3 — auto-bump is mandatory regardless of $cas. Otherwise OCC
  // silently degrades on tables where callers forgot to pass $cas.
  it("auto-bumps version on update with no $cas", async () => {
    await users.insertOne({ id: 1, name: "Ada", status: "active", counter: 0, version: 0 } as any);
    const result = await users.updateOne({ id: 1, name: "Ada Lovelace" } as any);
    expect(result.matchedCount).toBe(1);
    const row = (await users.findOne({ filter: { id: 1 }, controls: {} })) as any;
    expect(row.name).toBe("Ada Lovelace");
    expect(row.version).toBe(1);
  });

  // WHY: happy path of the entire feature — matching $cas succeeds and bumps.
  it("succeeds on updateOne with matching $cas, version increments by 1", async () => {
    await users.insertOne({ id: 1, name: "Ada", status: "active", counter: 0, version: 0 } as any);
    const result = await users.updateOne({
      id: 1,
      name: "Updated",
      $cas: { version: 0 },
    } as any);
    expect(result.matchedCount).toBe(1);
    expect(result.modifiedCount).toBe(1);
    const row = (await users.findOne({ filter: { id: 1 }, controls: {} })) as any;
    expect(row.name).toBe("Updated");
    expect(row.version).toBe(1);
  });

  // WHY: load-bearing stale-detection — if this passes when it shouldn't,
  // OCC is broken end-to-end. Returns matchedCount=0 and leaves the row alone.
  it("returns matchedCount=0 on updateOne with stale $cas; row untouched", async () => {
    await users.insertOne({ id: 1, name: "Ada", status: "active", counter: 0, version: 0 } as any);
    const result = await users.updateOne({
      id: 1,
      name: "WillNotApply",
      $cas: { version: 99 },
    } as any);
    expect(result.matchedCount).toBe(0);
    expect(result.modifiedCount).toBe(0);
    const row = (await users.findOne({ filter: { id: 1 }, controls: {} })) as any;
    expect(row.name).toBe("Ada");
    expect(row.version).toBe(0);
  });

  // WHY: locked decision #1 — server-managed column protected at SDK
  // boundary so the auto-bump invariant never gets corrupted (Rule 12).
  it("rejects direct SET of the version column", async () => {
    await users.insertOne({ id: 1, name: "Ada", status: "active", counter: 0, version: 0 } as any);
    await expect(users.updateOne({ id: 1, version: 5 } as any)).rejects.toThrow(/version/i);
  });

  // WHY: $inc on the version column would compound with the auto-bump
  // (+1 + N), breaking the monotonic-by-one invariant that CAS depends on.
  it("rejects $inc on the version column", async () => {
    await users.insertOne({ id: 1, name: "Ada", status: "active", counter: 0, version: 0 } as any);
    await expect(users.updateOne({ id: 1, version: { $inc: 1 } } as any)).rejects.toThrow(DbError);
  });

  // WHY: §4.2 — bulkUpdate is the version-locked batch primitive. Mixed
  // fresh/stale $cas: only fresh entries apply, others silently skip.
  it("bulkUpdate with mixed $cas — fresh succeeds, stale silently skipped", async () => {
    await users.insertMany([
      { id: 1, name: "A", status: "active", counter: 0, version: 0 },
      { id: 2, name: "B", status: "active", counter: 0, version: 0 },
    ] as any[]);
    const result = await users.bulkUpdate([
      { id: 1, name: "A2", $cas: { version: 0 } }, // fresh
      { id: 2, name: "B2", $cas: { version: 99 } }, // stale
    ] as any[]);
    expect(result.matchedCount).toBe(1);
    const r1 = (await users.findOne({ filter: { id: 1 }, controls: {} })) as any;
    const r2 = (await users.findOne({ filter: { id: 2 }, controls: {} })) as any;
    expect(r1.name).toBe("A2");
    expect(r1.version).toBe(1);
    expect(r2.name).toBe("B"); // unchanged
    expect(r2.version).toBe(0); // unchanged
  });

  // WHY: §9.2 — replaceOne must support $cas with the same semantics as
  // updateOne. Mongo requires an aggregation pipeline (`$replaceWith` +
  // `$add: ['$version', 1]`) since plain replaceOne can't $inc.
  it("replaceOne with matching $cas succeeds and bumps version", async () => {
    await users.insertOne({ id: 1, name: "Ada", status: "active", counter: 5, version: 0 } as any);
    const result = await users.replaceOne({
      id: 1,
      name: "AdaReplaced",
      status: "inactive",
      counter: 10,
      $cas: { version: 0 },
    } as any);
    expect(result.matchedCount).toBe(1);
    const row = (await users.findOne({ filter: { id: 1 }, controls: {} })) as any;
    expect(row.name).toBe("AdaReplaced");
    expect(row.counter).toBe(10);
    expect(row.version).toBe(1);
  });

  // WHY: stale-detection on the replace path — same load-bearing behavior.
  it("replaceOne with stale $cas returns matchedCount=0; row untouched", async () => {
    await users.insertOne({ id: 1, name: "Ada", status: "active", counter: 5, version: 0 } as any);
    const result = await users.replaceOne({
      id: 1,
      name: "Nope",
      status: "inactive",
      counter: 99,
      $cas: { version: 42 },
    } as any);
    expect(result.matchedCount).toBe(0);
    const row = (await users.findOne({ filter: { id: 1 }, controls: {} })) as any;
    expect(row.name).toBe("Ada");
    expect(row.counter).toBe(5);
    expect(row.version).toBe(0);
  });

  // WHY: catches the bug where a caller thinks they have OCC but the table
  // has no version column. Fail-loud (Rule 12) at the SDK boundary.
  it("rejects $cas on a non-versioned table", async () => {
    await widgets.insertOne({ id: 1, name: "Widget" } as any);
    await expect(
      widgets.updateOne({ id: 1, name: "X", $cas: { version: 1 } } as any),
    ).rejects.toThrow(DbError);
  });

  // WHY: locked decision row 2 — updateMany never CAS-checks; supplying
  // $cas is a programmer error. Per-row CAS belongs in bulkUpdate.
  it("rejects $cas on updateMany", async () => {
    await users.insertOne({ id: 1, name: "Ada", status: "active", counter: 0, version: 0 } as any);
    await expect(
      users.updateMany({ status: "active" }, { status: "x", $cas: { version: 0 } } as any),
    ).rejects.toThrow(DbError);
  });

  // WHY: auto-bump is per-versioned-table, not per-CAS-using call. Every
  // updateMany on a versioned table must still bump.
  it("updateMany on a versioned table still auto-bumps each row", async () => {
    await users.insertMany([
      { id: 1, name: "A", status: "active", counter: 0, version: 0 },
      { id: 2, name: "B", status: "active", counter: 0, version: 0 },
    ] as any[]);
    await users.updateMany({ status: "active" }, { status: "suspended" });
    const r1 = (await users.findOne({ filter: { id: 1 }, controls: {} })) as any;
    const r2 = (await users.findOne({ filter: { id: 2 }, controls: {} })) as any;
    expect(r1.status).toBe("suspended");
    expect(r1.version).toBe(1);
    expect(r2.status).toBe("suspended");
    expect(r2.version).toBe(1);
  });

  // WHY: §9.1 — atomic composition of field ops and $cas in a single
  // statement. Counter increments, version increments, both under CAS.
  it("$cas + $inc on a different column: both apply atomically when version matches", async () => {
    await users.insertOne({ id: 1, name: "Ada", status: "active", counter: 0, version: 0 } as any);
    const result = await users.updateOne({
      id: 1,
      counter: { $inc: 5 },
      $cas: { version: 0 },
    } as any);
    expect(result.matchedCount).toBe(1);
    const row = (await users.findOne({ filter: { id: 1 }, controls: {} })) as any;
    expect(row.counter).toBe(5);
    expect(row.version).toBe(1);
  });
});
