import { beforeAll, describe, expect, it } from "vite-plus/test";

import { createTestSpace, prepareFixtures } from "./test-utils.js";

const mongo = createTestSpace();

describe("asCollection flatten", () => {
  beforeAll(prepareFixtures);
  it("must flatten correctly", async () => {
    const { FlattenTest } = await import("./fixtures/flatten-test.as");
    const table = mongo.getTable(FlattenTest);
    expect(table.flatMap.has("level0")).toBe(true);
    expect(table.flatMap.has("nested")).toBe(true);
    expect(table.flatMap.has("nested.level1")).toBe(true);
    expect(table.flatMap.has("nested.array1")).toBe(true);
    expect(table.flatMap.has("array0")).toBe(true);
    expect(table.flatMap.has("array0.level1")).toBe(true);
    expect(table.flatMap.has("nested.array1.level2")).toBe(true);
    expect(table.flatMap.has("nested.array1.array2")).toBe(true);
    expect(table.flatMap.has("nested.array1.array2.level3")).toBe(true);
    expect(table.flatMap.has("complexArray")).toBe(true);
    expect(table.flatMap.has("complexArray.field1")).toBe(true);
    expect(table.flatMap.has("complexArray.field2")).toBe(true);
    // @ts-expect-error
    expect(table.flatMap.get("complexArray.field1")?.type?.items).toHaveLength(2);
    // @ts-expect-error
    expect(table.flatMap.get("complexArray.field1")?.type?.items[0]?.type?.designType).toBe(
      "string",
    );
    // @ts-expect-error
    expect(table.flatMap.get("complexArray.field1")?.type?.items[1]?.type?.designType).toBe(
      "number",
    );
  });
});
