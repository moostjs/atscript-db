import { describe, it, expect, beforeAll } from "vite-plus/test";

import { createTestSpace, prepareFixtures } from "./test-utils";

// `@db.default 0` / `true` / `"active"` / `10.50`: an insert without the
// fields stores the typed values (a decimal as its string).

beforeAll(prepareFixtures);

describe("[memory] typed @db.default literals", () => {
  it("fills absent fields with typed values", async () => {
    const { TypedDefaults } = await import("./fixtures/typed-defaults.as");
    const space = createTestSpace();
    const table = space.getTable(TypedDefaults);
    await space.getAdapter(TypedDefaults).ensureTable();
    await table.insertOne({ id: 1 } as any);
    expect(await table.findById(1)).toEqual({
      id: 1,
      attempts: 0,
      delta: -1.5,
      enabled: true,
      archived: false,
      status: "active",
      price: "10.50",
    });
  });
});
