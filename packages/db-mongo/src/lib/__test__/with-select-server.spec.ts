import { DbSpace } from "@atscript/db";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// `$with` projections on MongoDB (mongodb-memory-server), since 0.1.143:
// - the `$lookup` sub-select takes every `$select` form — array, inclusion
//   map and exclusion map (an HTTP layer seals joined write-only fields with
//   an exclusion map) — and never drops the join key;
// - a top-level `$select` that leaves out the key a relation joins on still
//   loads the relation (the key is read, then stripped).

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;
let owners: Record<string, any>;

const accounts = () => space.getTable(fx.NvAccount) as any;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/nav-props.as");
  owners = await import("./fixtures/nav-owner.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("with_select");
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  space = new DbSpace(() => new MongoAdapter(db, client));
  await space.getTable(owners.NvOwner).insertOne({ id: 1, name: "o1", address: { city: "c" } });
  await accounts().insertOne({ id: 1, label: "a1", ownerId: 1 });
  await space.getTable(fx.NvCard).insertMany([
    { id: 1, accountId: 1, status: "active" },
    { id: 2, accountId: 1, status: "closed" },
  ]);
});

const cardsWith = async (controls: Record<string, unknown>) => {
  const [row] = await accounts().findMany({
    filter: {},
    controls: { $with: [{ name: "cards", controls }] },
  });
  return (row.cards as Array<Record<string, unknown>>).toSorted(
    (a, b) => Number(a.id) - Number(b.id),
  );
};

describe("MongoDB: $with sub-select forms", () => {
  it("array form", async () => {
    const cards = await cardsWith({ $select: ["status"] });
    expect(cards.map((c) => c.status)).toEqual(["active", "closed"]);
    expect(cards[0]).not.toHaveProperty("_id");
  });

  it("inclusion map", async () => {
    const cards = await cardsWith({ $select: { id: 1, status: 1 } });
    expect(cards).toEqual([
      expect.objectContaining({ id: 1, status: "active" }),
      expect.objectContaining({ id: 2, status: "closed" }),
    ]);
  });

  it("exclusion map (the write-only seal shape)", async () => {
    const cards = await cardsWith({ $select: { status: 0 } });
    expect(cards.map((c) => c.id)).toEqual([1, 2]);
    expect(cards[0]).not.toHaveProperty("status");
  });

  it("an exclusion of the join key keeps the key", async () => {
    const cards = await cardsWith({ $select: { accountId: 0, status: 0 } });
    expect(cards.map((c) => c.id)).toEqual([1, 2]);
  });

  it("nested $with with an exclusion map", async () => {
    const cards = await cardsWith({
      $select: { status: 0 },
      $with: [{ name: "account", controls: { $select: { label: 0 } } }],
    });
    expect(cards[0]!.account).toMatchObject({ id: 1, ownerId: 1 });
    expect(cards[0]!.account).not.toHaveProperty("label");
  });
});

describe("MongoDB: $with joins through keys $select omits", () => {
  it("TO relation with neither the foreign nor the primary key selected", async () => {
    const [row] = await accounts().findMany({
      filter: {},
      controls: { $select: ["label"], $with: [{ name: "owner" }] },
    });
    expect(row.owner).toMatchObject({ id: 1, name: "o1" });
    expect(row).not.toHaveProperty("ownerId");
    expect(row).not.toHaveProperty("id");
  });
});
