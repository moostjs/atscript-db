import { DbSpace } from "@atscript/db";
import type { MongoClient } from "mongodb";
import { describe, beforeAll, afterAll, beforeEach } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";
import { defineDefaultConvergenceCases } from "../../../../db/test-kit/default-convergence-cases";

// mongodb-memory-server: a forced re-sync of every default and index kind
// stays in sync (defaults diff against the stored snapshot; indexes against
// listIndexes), and index work is reported on plan and run entries.

let server: any;
let client: MongoClient;
let fx: Record<string, any>;
let space: DbSpace;
let n = 0;

describe("MongoDB — forced sync converges over every default and index kind", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/default-kinds.as");
    const { MongoMemoryServer } = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server = await MongoMemoryServer.create();
    client = new MC(server.getUri());
    await client.connect();
  }, 60_000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  beforeEach(() => {
    const db = client.db(`default_convergence_${++n}`);
    space = new DbSpace(() => new MongoAdapter(db, client));
  });

  defineDefaultConvergenceCases(() => ({ fx, space, indexes: true }));
});
