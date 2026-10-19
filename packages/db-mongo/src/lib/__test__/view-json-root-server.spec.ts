import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";
import { VJR_ITEMS, defineViewJsonRootCases } from "../../../../db/test-kit/view-json-root-cases";

// A view field over a whole primitive @db.json field returns, sorts and
// filters by the typed value — the same result as the SQL adapters (which
// extract the JSON root since 0.1.162; a document stores the value natively).

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-json-root.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("view_json_root");
  space = new DbSpace(() => new MongoAdapter(db, client));
  const result = await new SchemaSync(space).run([fx.VjrItem, fx.VjrItemView], { force: true });
  expect(result.status).toBe("synced");
  await space.getTable(fx.VjrItem as never).insertMany(VJR_ITEMS);
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

describe("MongoDB views — primitive @db.json source field", () => {
  defineViewJsonRootCases({ view: () => space.getView(fx.VjrItemView as never), omitId: true });
});
