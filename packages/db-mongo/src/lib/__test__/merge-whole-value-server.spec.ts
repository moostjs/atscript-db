import { randomBytes } from "node:crypto";
import { DbSpace } from "@atscript/db";
import type { AtscriptDbTable } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { MongoClient } from "mongodb";
import { describe, beforeAll, beforeEach, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import {
  defineMergeWholeValueCases,
  mergeOnJsonField,
} from "../../../../db/test-kit/merge-whole-value-cases";
import { prepareFixtures } from "./test-utils";

// The shared merge-whole-value cases against a real MongoDB (mongodb-memory-server).

let server: any;
let client: MongoClient;
let MwvItem: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ MwvItem } = await import("./fixtures/merge-whole-value.as"));
  mergeOnJsonField(MwvItem);
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

let dbSeq = 0;

describe("MongoDB — a merge strategy below a whole value", () => {
  let items: AtscriptDbTable;

  beforeEach(async () => {
    const db = client.db(`merge_whole_value_${++dbSeq}`);
    const space = new DbSpace(() => new MongoAdapter(db, client), {
      encryption: { defaultKeyId: "k1", keys: { k1: randomBytes(32) } },
    });
    await new SchemaSync(space).run([MwvItem], { force: true });
    items = space.getTable(MwvItem);
  });

  defineMergeWholeValueCases(() => items);
});
