import { describe, it, expect, beforeAll, afterEach, vi } from "vite-plus/test";

import type { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Since 0.1.165 `number.timestamp.created` is insert-only: a full replace
// keeps the stored value (`$replaceWith` maps the field to itself) and the
// payload's value never reaches the database.

const mongo = createTestSpace();

beforeAll(prepareFixtures);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[mongo] created is insert-only", () => {
  it("replaceOne keeps $createdAt and drops the payload's value", async () => {
    const { CioNote } = await import("./fixtures/created-insert-only.as");
    const table = mongo.getTable(CioNote);
    const adapter = mongo.getAdapter(CioNote) as unknown as MongoAdapter;
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const replaceOne = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    vi.spyOn(adapter, "collection", "get").mockReturnValue({ updateOne, replaceOne } as never);
    await table.replaceOne({ _id: "a", title: "t", createdAt: 5 } as never);
    expect(replaceOne).not.toHaveBeenCalled();
    const pipeline = updateOne.mock.calls[0]![1] as Array<Record<string, any>>;
    expect(pipeline[0]!.$replaceWith.createdAt).toBe("$createdAt");
    expect(pipeline[0]!.$replaceWith.title).toEqual({ $literal: "t" });
  });

  it("updateOne drops the payload's value", async () => {
    const { CioNote } = await import("./fixtures/created-insert-only.as");
    const table = mongo.getTable(CioNote);
    const adapter = mongo.getAdapter(CioNote) as unknown as MongoAdapter;
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    vi.spyOn(adapter, "collection", "get").mockReturnValue({ updateOne } as never);
    await table.updateOne({ _id: "a", title: "t", createdAt: 5 } as never);
    expect(JSON.stringify(updateOne.mock.calls[0]![1])).not.toContain("createdAt");
  });
});
