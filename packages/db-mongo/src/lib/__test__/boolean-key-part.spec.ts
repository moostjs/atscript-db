import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// A boolean part of a composite key (since 0.1.192): the framework hands over
// a real boolean (the text `true` / `false` of a URL included) and `prepareId`
// keeps it — `String(true)` never equals a stored `true`.

const mongo = createTestSpace();

describe("[mongo] a boolean part of a composite key", () => {
  let table: ReturnType<typeof mongo.getTable>;
  let adapter: MongoAdapter;

  beforeAll(async () => {
    await prepareFixtures();
    const { BkDraft } = await import("./fixtures/boolean-key.as");
    table = mongo.getTable(BkDraft);
    adapter = mongo.getAdapter(BkDraft) as unknown as MongoAdapter;
  });
  afterEach(() => vi.restoreAllMocks());

  it("prepareId keeps the boolean", () => {
    expect(adapter.prepareId(true, table.flatMap.get("active")!)).toBe(true);
    expect(adapter.prepareId(false, table.flatMap.get("active")!)).toBe(false);
  });

  it.each([
    ["true", true],
    ["false", false],
    [true, true],
  ])("findById with active %j reads with the boolean %j", async (active, expected) => {
    const findOne = vi.spyOn(adapter, "findOne").mockResolvedValue(null);
    await table.findById({ id: "a", active } as never);
    expect(findOne).toHaveBeenCalledOnce();
    expect(findOne.mock.calls[0]![0].filter).toEqual({ id: "a", active: expected });
  });
});

describe("[mongo] a nullable boolean part of a compound unique index", () => {
  let table: ReturnType<typeof mongo.getTable>;
  let adapter: MongoAdapter;

  beforeAll(async () => {
    await prepareFixtures();
    const { BkFlag } = await import("./fixtures/boolean-key.as");
    table = mongo.getTable(BkFlag);
    adapter = mongo.getAdapter(BkFlag) as unknown as MongoAdapter;
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["true", true],
    ["false", false],
    [true, true],
  ])("findById with flag %j reads with the boolean %j", async (flag, expected) => {
    const findOne = vi.spyOn(adapter, "findOne").mockResolvedValue(null);
    await table.findById({ code: "x", flag } as never);
    expect(findOne).toHaveBeenCalledOnce();
    expect(findOne.mock.calls[0]![0].filter).toEqual({ code: "x", flag: expected });
  });
});
