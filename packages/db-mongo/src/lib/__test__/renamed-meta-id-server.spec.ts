import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// The managed `__pk` unique index of a non-`_id` `@meta.id` renamed with
// `@db.column` is built on the STORED key (mongodb-memory-server). On the
// logical name every document indexes `null`, so the second insert failed
// with E11000.

let server: any;
let client: MongoClient;
let db: Db;
let fx: Record<string, any>;

const PK_INDEX = "atscript__unique___pk";

async function pkIndexKey(): Promise<unknown> {
  const indexes = await db.collection("renamed_pk_tags").indexes();
  return indexes.find((i) => i.name === PK_INDEX)?.key;
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/renamed-meta-id.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("renamed_meta_id");
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

describe("[mongo] a @db.column-renamed @meta.id", () => {
  it("migrates an index left on the logical name; rows insert and stay unique", async () => {
    // What earlier versions created: the index on the logical name.
    await db.createCollection("renamed_pk_tags");
    await db
      .collection("renamed_pk_tags")
      .createIndex({ code: 1 }, { name: PK_INDEX, unique: true });

    const space = new DbSpace(() => new MongoAdapter(db, client));
    const result = await new SchemaSync(space).run([fx.RenamedPkTag], { force: true });
    expect(result.status).toBe("synced");
    expect(await pkIndexKey()).toEqual({ tag_code: 1 });

    const tags = space.getTable(fx.RenamedPkTag);
    await tags.insertOne({ code: "a", title: "A" } as never);
    await tags.insertOne({ code: "b", title: "B" } as never);
    expect((await db.collection("renamed_pk_tags").findOne({ tag_code: "b" }))?.title).toBe("B");
    await expect(tags.insertOne({ code: "a", title: "again" } as never)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(((await tags.findOne({ filter: { code: "b" } } as never)) as any)?.title).toBe("B");
  });
});
