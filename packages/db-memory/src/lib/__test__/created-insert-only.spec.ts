import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

// Since 0.1.165 `number.timestamp.created` is insert-only: the memory
// adapter's full replace carries the stored value over, and a replace or
// patch payload cannot overwrite it.

let fx: Record<string, any>;
let notes: any;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/created-insert-only.as");
});

beforeEach(async () => {
  const space = createTestSpace();
  await bootstrapStoredTables(space, [fx.CioNote]);
  notes = space.getTable(fx.CioNote);
  await notes.insertOne({ id: 1, title: "a", createdAt: 1000 });
});

const createdAt = async () => (await notes.findById(1)).createdAt;

describe("[memory] created is insert-only", () => {
  it("replaceOne without createdAt keeps the stored value", async () => {
    await notes.replaceOne({ id: 1, title: "b" });
    expect(await createdAt()).toBe(1000);
    expect((await notes.findById(1)).title).toBe("b");
  });

  it("replace / patch payloads cannot overwrite it", async () => {
    await notes.replaceOne({ id: 1, title: "b", createdAt: 5 });
    await notes.updateOne({ id: 1, createdAt: 6 });
    await notes.updateMany({ id: 1 }, { createdAt: 7 });
    await notes.replaceMany({ id: 1 }, { title: "c", createdAt: 8 });
    expect(await createdAt()).toBe(1000);
  });
});
