import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Navigation properties on MongoDB (mongodb-memory-server): a nav field's
// subfields (`owner.name`, `cards.status`, same-file and cross-file targets)
// are never columns — the plan lists none of them and a run adds / backfills /
// unsets none. The snapshot keeps listing them, as releases before 0.1.141
// did, so the upgrade changes no stored hash.

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;
let owners: Record<string, any>;

const inventory = () => [owners.NvOwner, fx.NvAccount, fx.NvCard];
const names = (entries: readonly any[], name: string) =>
  entries.find((e) => e.name === name)!.columnsToAdd.map((c: any) => c.physicalName);

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/nav-props.as");
  owners = await import("./fixtures/nav-owner.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("nav_props");
  space = new DbSpace(() => new MongoAdapter(db, client));
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

describe("MongoDB: navigation properties are not columns", () => {
  it("the plan of a new table lists only stored fields", async () => {
    const plan = await new SchemaSync(space).plan(inventory());
    expect(plan.entries.map((e) => e.status)).toEqual(["create", "create", "create"]);
    expect(names(plan.entries, "nv_accounts")).toEqual(["id", "label", "ownerId", "_id"]);
    expect(names(plan.entries, "nv_cards")).toEqual(["id", "accountId", "status", "_id"]);
    const account = space.getTable(fx.NvAccount);
    expect(account.columnDescriptors.map((f) => f.path)).toEqual(["id", "label", "ownerId", "_id"]);
    expect(account.storedDescriptors.map((f) => f.path)).toEqual(["id", "label", "ownerId", "_id"]);
    // The nav subfields stay in `fieldDescriptors` (declared shape), ignored
    expect(account.fieldDescriptors.filter((f) => f.ignored).map((f) => f.path)).toEqual([
      "owner",
      "owner.id",
      "owner.name",
      "owner.address",
      "owner.address.city",
      "cards",
      "cards.id",
      "cards.accountId",
      "cards.status",
      "cards.account",
    ]);
  });

  it("a run is in sync afterwards; the snapshot still lists them", async () => {
    const sync = new SchemaSync(space);
    const result = await sync.run(inventory(), { force: true });
    expect(result.status).toBe("synced");
    const snapshot = await db
      .collection("__atscript_control")
      .findOne({ _id: "table_snapshot:nv_cards" } as never);
    const fields = JSON.parse((snapshot as any).value).fields.map((f: any) => f.physicalName);
    expect(fields).toEqual(
      expect.arrayContaining(["_id", "accountId", "id", "status", "account.id", "account.label"]),
    );
    expect(fields).not.toContain("account");
    expect((await sync.plan(inventory())).entries.map((e) => e.status)).toEqual([
      "in-sync",
      "in-sync",
      "in-sync",
    ]);
  });

  it("a re-sync drops, backfills and unsets nothing under a nav path", async () => {
    const control = db.collection("__atscript_control");
    const before = (await control.findOne({ _id: "table_snapshot:nv_cards" } as never)) as any;
    // A raw document with data under the nav path (never written by the table) must survive
    const raw = db.collection("nv_cards");
    await raw.insertOne({
      id: 7,
      accountId: 1,
      status: "active",
      account: { id: 1, label: "kept" },
    });

    const sync = new SchemaSync(space);
    const plan = await sync.plan(inventory());
    const cards = plan.entries.find((e) => e.name === "nv_cards")!;
    expect(cards.status).toBe("in-sync");
    expect(cards.columnsToDrop).toEqual([]);
    expect(cards.columnsToAdd).toEqual([]);
    expect(cards.destructive).toBe(false);

    const result = await sync.run(inventory(), { force: true });
    expect(result.status).toBe("synced");
    expect(result.entries.find((e) => e.name === "nv_cards")!.status).toBe("in-sync");
    expect(await raw.findOne({ id: 7 }, { projection: { _id: 0 } })).toEqual({
      id: 7,
      accountId: 1,
      status: "active",
      account: { id: 1, label: "kept" },
    });
    const after = (await control.findOne({ _id: "table_snapshot:nv_cards" } as never)) as any;
    expect(after.value).toBe(before.value);
  });
});
