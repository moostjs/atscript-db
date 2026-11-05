import type { TColumnDiff, TDbFieldMeta } from "@atscript/db";
import { describe, it, expect, beforeAll, afterEach, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { syncColumnsImpl } from "../mongo-schema-sync";
import { createTestSpace, prepareFixtures } from "./test-utils";

// `@db.default 0` / `true` / `"active"` / `10.50`: added fields are
// backfilled with the value an insert fills — typed, a decimal as its string.

const mongo = createTestSpace();

beforeAll(prepareFixtures);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("[mongo] typed @db.default literals", () => {
  it("backfills each added field with the typed value", async () => {
    const { TypedDefaults } = await import("./fixtures/typed-defaults.as");
    const table = mongo.getTable(TypedDefaults);
    const adapter = mongo.getAdapter(TypedDefaults) as unknown as MongoAdapter;
    const updateMany = vi.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    vi.spyOn(adapter, "collection", "get").mockReturnValue({ updateMany } as any);

    const added = table.fieldDescriptors.filter((f: TDbFieldMeta) => f.defaultValue);
    const diff: TColumnDiff = {
      added,
      removed: [],
      renamed: [],
      typeChanged: [],
      nullableChanged: [],
      defaultChanged: [],
      conflicts: [],
    };
    await syncColumnsImpl(adapter as any, diff);
    const sets = Object.assign({}, ...updateMany.mock.calls.map(([, update]) => update.$set));
    expect(sets).toEqual({
      attempts: 0,
      delta: -1.5,
      enabled: true,
      archived: false,
      status: "active",
      price: "10.50",
    });
  });
});
