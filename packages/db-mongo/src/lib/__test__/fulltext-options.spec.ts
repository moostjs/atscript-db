import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";

import { MongoAdapter } from "../mongo-adapter";
import { mongoRequireEveryTerm } from "../mongo-search";
import { prepareFixtures } from "./test-utils";

// `@db.index.fulltext.language` / `.match` on a real MongoDB
// (mongodb-memory-server, since 0.1.168): the language is the text index's
// `default_language` (a change rebuilds it); `match "all"` requires every word.

let fx: Record<string, any>;
let server: any;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/fulltext-options.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("ftoptions");
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

const ids = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => r.id as number).toSorted((a, b) => a - b);

const textIndex = async () =>
  (await db.collection("fto_docs").listIndexes().toArray()).find(
    (i) => i.name === "atscript__fulltext__ft_body",
  );

describe("[mongo] fulltext language and match", () => {
  it("v1: english text index, any word matches", async () => {
    const space = new DbSpace(() => new MongoAdapter(db, client));
    expect((await new SchemaSync(space).run([fx.FtoDocV1], { force: true })).status).toBe("synced");
    expect((await textIndex())?.default_language).toBe("english");
    const docs = space.getTable(fx.FtoDocV1) as any;
    await docs.insertMany([
      { id: 1, body: "красная кошка" },
      { id: 2, body: "синяя кошка" },
      { id: 3, body: "красная собака" },
    ]);
    expect(ids(await docs.search("красная кошка", {}))).toEqual([1, 2, 3]);
  });

  it("v2: the index is rebuilt with default_language russian; all words required", async () => {
    const space = new DbSpace(() => new MongoAdapter(db, client));
    const result = await new SchemaSync(space).run([fx.FtoDocV2]);
    expect(result.status).toBe("synced");
    expect((await textIndex())?.default_language).toBe("russian");
    const docs = space.getTable(fx.FtoDocV2) as any;
    expect(ids(await docs.search("красная кошка", {}))).toEqual([1]);
    // A second sync keeps the index.
    const again = await new SchemaSync(space).run([fx.FtoDocV2], { force: true });
    expect(again.entries.flatMap((e) => e.indexChanges ?? [])).toEqual([]);
  });

  it("mongoRequireEveryTerm makes each word a phrase", () => {
    expect(mongoRequireEveryTerm('red "big cat" -dog')).toBe('"red" "big cat" "dog"');
    expect(mongoRequireEveryTerm('a\\" ""')).toBe('"a"');
  });

  it("mongoRequireEveryTerm splits a word on punctuation before quoting", () => {
    expect(mongoRequireEveryTerm("e-mail quok* (кошка)")).toBe('"e" "mail" "quok" "кошка"');
    expect(mongoRequireEveryTerm("*** --")).toBe("");
  });
});
