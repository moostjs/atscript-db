import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

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
  await space
    .getTable(fx.VjrItem as never)
    .insertMany([
      { id: 1, score: 9, label: "b", active: true },
      { id: 2, score: 10, label: "a", active: false },
      { id: 3, score: 2.5, label: "c", active: true },
      { id: 4 },
    ] as never);
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

const view = () => space.getView(fx.VjrItemView as never) as any;
const ids = async (query: { filter?: object; controls?: object }) =>
  (
    (await view().findMany({
      filter: query.filter ?? {},
      controls: { $select: ["id"], ...query.controls },
    })) as Array<{ id: number }>
  ).map((r) => r.id);

describe("MongoDB views — primitive @db.json source field", () => {
  it("returns the typed values", async () => {
    const rows = (await view().findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as Array<
      Record<string, unknown>
    >;
    expect(rows.map(({ _id, ...rest }) => rest)).toEqual([
      { id: 1, score: 9, label: "b", active: true },
      { id: 2, score: 10, label: "a", active: false },
      { id: 3, score: 2.5, label: "c", active: true },
      { id: 4, score: null, label: null, active: null },
    ]);
  });

  it("sorts and filters by the typed value", async () => {
    expect(
      await ids({ filter: { score: { $exists: true } }, controls: { $sort: { score: 1 } } }),
    ).toEqual([3, 1, 2]);
    expect(
      await ids({ filter: { score: { $gt: 5 } }, controls: { $sort: { score: -1 } } }),
    ).toEqual([2, 1]);
    expect(await ids({ filter: { active: true }, controls: { $sort: { id: 1 } } })).toEqual([1, 3]);
    expect(
      await ids({ filter: { label: { $exists: true } }, controls: { $sort: { label: 1 } } }),
    ).toEqual([2, 1, 3]);
  });
});
