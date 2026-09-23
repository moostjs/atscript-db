import { describe, it, expect } from "vite-plus/test";

import { DbSpace } from "@atscript/db";

import { MemoryAdapter, createAdapter } from "../index.js";

describe("MemoryAdapter scaffold", () => {
  it("reports native nested-object support", () => {
    expect(new MemoryAdapter().supportsNestedObjects()).toBe(true);
  });

  it("createAdapter() returns a DbSpace", () => {
    expect(createAdapter()).toBeInstanceOf(DbSpace);
  });

  it("aggregates in memory instead of inheriting the base adapter's throw", async () => {
    // Aggregation is a real in-memory grouping engine (aggregate.spec.ts); an
    // empty store groups to no rows.
    await expect(
      new MemoryAdapter().aggregate({ filter: {}, controls: { $groupBy: ["age"] } as any }),
    ).resolves.toEqual([]);
  });
});
