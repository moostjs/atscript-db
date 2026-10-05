import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { expect, beforeAll, afterAll } from "vite-plus/test";

import { AE_ROWS, defineAggregateExprCases } from "../../../../db/test-kit/aggregate-expr-cases";
import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Query-time arithmetic and first / last against a real MongoDB
// (mongodb-memory-server), since 0.1.148: the shared case table every adapter
// runs.

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/agg-expr.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("agg_expr");
  space = new DbSpace(() => new MongoAdapter(db, client));
  const result = await new SchemaSync(space).run([fx.AeIssue], { force: true });
  expect(result.status).toBe("synced");
  await space.getTable(fx.AeIssue).insertMany(AE_ROWS as never);
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

defineAggregateExprCases("MongoDB", () => space.getTable(fx.AeIssue) as never);
