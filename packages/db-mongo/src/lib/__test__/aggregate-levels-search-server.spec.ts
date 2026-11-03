import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { MongoClient } from "mongodb";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// A two-level aggregate under a root `$search` on a real server (`$text`,
// mongodb-memory-server): the search narrows the rows the inner level groups,
// and a blank term answers no rows (`$count` 0) — since 0.1.168.

let fx: Record<string, any>;
let space: DbSpace;
let server: any;
let client: MongoClient;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/agg-levels-search.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  space = new DbSpace(() => new MongoAdapter(client.db("aglsearch"), client));
  const result = await new SchemaSync(space).run([fx.AlArticle], { force: true });
  expect(result.status).toBe("synced");
  await space.getTable(fx.AlArticle).insertMany([
    { id: 1, title: "Machine Learning Basics", category: "tech" },
    { id: 2, title: "Database Design", category: "tech" },
    { id: 3, title: "Machine Vision", category: "tech" },
    { id: 4, title: "Machine Roasted Coffee", category: "food" },
    { id: 5, title: "Bread Baking", category: "food" },
    { id: 6, title: "Island Hopping", category: "travel" },
  ] as never);
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

const perCategory = (extra: Record<string, unknown> = {}) =>
  space.getTable(fx.AlArticle).aggregate({
    filter: {},
    controls: {
      $from: { $groupBy: ["category"], $select: [{ $fn: "count", $field: "*", $as: "cnt" }] },
      $select: [
        { $fn: "sum", $field: "cnt", $as: "total" },
        { $fn: "count", $field: "*", $as: "categories" },
      ],
      ...extra,
    },
  } as never);

describe("[mongo] two-level aggregate + $search ($text)", () => {
  it("searches the rows the inner level groups", async () => {
    expect(await perCategory({ $search: "machine" })).toEqual([{ total: 3, categories: 2 }]);
    expect(await perCategory()).toEqual([{ total: 6, categories: 3 }]);
  });

  it("answers a blank term with no rows, and $count 0", async () => {
    expect(await perCategory({ $search: "   " })).toEqual([]);
    expect(await perCategory({ $search: "   ", $count: true })).toEqual([{ count: 0 }]);
  });
});
