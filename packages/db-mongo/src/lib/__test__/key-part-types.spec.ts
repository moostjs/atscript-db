import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// A key part takes its field's column type (since 0.1.194): `T | null` is a
// `T`, number literals (`1 | 2 | 3`) a number. The framework hands over the
// text a URL carries and `prepareId` converts it — `String(7)` never equals
// a stored 7.

const mongo = createTestSpace();
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/key-types.as");
});
afterEach(() => vi.restoreAllMocks());

function tableOf(name: string) {
  const table = mongo.getTable(fx[name]);
  const adapter = mongo.getAdapter(fx[name]) as unknown as MongoAdapter;
  return { table, adapter };
}

describe("[mongo] key parts typed `number | null` and by number literals", () => {
  it.each([
    ["KtCode", { code: "7" }, { code: 7 }],
    ["KtLevel", "2", { level: 2 }],
  ])("findById on %s with %j reads with %j", async (name, id, filter) => {
    const { table, adapter } = tableOf(name);
    const findOne = vi.spyOn(adapter, "findOne").mockResolvedValue(null);
    await table.findById(id as never);
    expect(findOne).toHaveBeenCalledOnce();
    expect(findOne.mock.calls[0]![0].filter).toEqual(filter);
  });
});
