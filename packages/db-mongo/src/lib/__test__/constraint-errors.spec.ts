import { describe, it, expect, beforeAll, afterEach, vi } from "vite-plus/test";
import { DbError } from "@atscript/db";
import { MongoServerError } from "mongodb";

import type { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Since 0.1.165 a duplicate-key error reports every key of the violated index
// (normalized by the table layer: one UNIQUE entry per field, `params`).
// Before, only the first key of `keyPattern` was reported.

const mongo = createTestSpace();

beforeAll(prepareFixtures);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[mongo] constraint errors", () => {
  it("a compound unique key: one UNIQUE entry per field", async () => {
    const { CeItem } = await import("./fixtures/constraint-errors.as");
    const table = mongo.getTable(CeItem);
    const adapter = mongo.getAdapter(CeItem) as unknown as MongoAdapter;
    const duplicate = new MongoServerError({
      message:
        'E11000 duplicate key error collection: test.ce_items index: atscript__unique__ce_household_name dup key: { householdId: 1, name: "salt" }',
      code: 11000,
      keyPattern: { householdId: 1, name: 1 },
    });
    vi.spyOn(adapter, "collection", "get").mockReturnValue({
      insertOne: () => Promise.reject(duplicate),
      insertMany: () => Promise.reject(duplicate),
    } as never);
    const error = await table
      .insertOne({ _id: "a", householdId: 1, name: "salt" } as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    const params = { index: "ce_household_name", fields: ["householdId", "name"] };
    expect((error as DbError).errors).toEqual([
      expect.objectContaining({ path: "householdId", code: "UNIQUE", params }),
      expect.objectContaining({ path: "name", code: "UNIQUE", params }),
    ]);
  });
});
