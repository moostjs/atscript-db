import { describe, it, expect, beforeAll } from "vite-plus/test";

import type { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/embedded-id.as");
});

function pkIndexes(adapter: MongoAdapter): Array<Record<string, number>> {
  return [...adapter["_mongoIndexes"].values()]
    .filter((idx: any) => idx.name === "__pk")
    .map((idx: any) => idx.fields);
}

describe("[mongo] @meta.id inside an embedded document", () => {
  it("is not part of the primary key nor a __pk unique index", () => {
    const space = createTestSpace();
    const orders = space.getTable(fx.EmbOrder);
    expect(orders.primaryKeys).toEqual(["id"]);
    expect([...orders.uniqueProps]).toEqual(["id", "_id"]);
    expect(pkIndexes(space.getAdapter(fx.EmbOrder) as unknown as MongoAdapter)).toEqual([
      { id: 1 },
    ]);
  });

  it("beside an explicit _id: only the host's @meta.id is the __pk unique field", () => {
    const space = createTestSpace();
    const docs = space.getTable(fx.EmbDoc);
    expect(docs.primaryKeys).toEqual(["_id"]);
    expect([...docs.uniqueProps]).toEqual(["code"]);
    expect(pkIndexes(space.getAdapter(fx.EmbDoc) as unknown as MongoAdapter)).toEqual([
      { code: 1 },
    ]);
  });
});
