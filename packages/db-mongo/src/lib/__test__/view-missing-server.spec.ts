import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// A view column whose source is missing on the document — an absent key, an
// absent JSON leaf, a JSON null — reads as null (SQL parity: every view column
// exists in every row), and as a group key missing and null form ONE group.
// Since 0.1.136.

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-missing.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("view_missing");
  space = new DbSpace(() => new MongoAdapter(db, client));
  const result = await new SchemaSync(space).run([fx.VmUser, fx.VmUserPrefs, fx.VmThemeCounts], {
    force: true,
  });
  expect(result.status).toBe("synced");
  // Raw writes: exactly the missing / null shapes the test names.
  await db
    .collection("vm_users")
    .insertMany([
      { id: 1, nickname: "ann", settings: { theme: "dark", fontSize: 14 } },
      { id: 2, settings: {} },
      { id: 3 },
      { id: 4, nickname: null, settings: { theme: null } },
    ] as never);
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

async function rows(type: unknown, sort: Record<string, 1 | -1>) {
  const found = await space
    .getView(type as never)
    .findMany({ filter: {}, controls: { $sort: sort } } as never);
  return (found as Array<Record<string, unknown>>).map(({ _id, ...rest }) => rest);
}

describe("MongoDB views — a missing source reads as null", () => {
  it("projects an absent key or JSON leaf as null instead of omitting it", async () => {
    expect(await rows(fx.VmUserPrefs, { id: 1 })).toEqual([
      { id: 1, nickname: "ann", theme: "dark", fontSize: 14 },
      { id: 2, nickname: null, theme: null, fontSize: null },
      { id: 3, nickname: null, theme: null, fontSize: null },
      { id: 4, nickname: null, theme: null, fontSize: null },
    ]);
  });

  it("groups missing and null under one null key", async () => {
    expect(await rows(fx.VmThemeCounts, { theme: 1 })).toEqual([
      { theme: null, users: 3 },
      { theme: "dark", users: 1 },
    ]);
  });
});
