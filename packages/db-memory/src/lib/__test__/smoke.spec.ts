import { describe, it, expect } from "vite-plus/test";

import { DbSpace, DbError } from "@atscript/db";

import { MemoryAdapter, createAdapter } from "../index.js";

describe("MemoryAdapter scaffold", () => {
  it("reports native nested-object support", () => {
    expect(new MemoryAdapter().supportsNestedObjects()).toBe(true);
  });

  it("createAdapter() returns a DbSpace", () => {
    expect(createAdapter()).toBeInstanceOf(DbSpace);
  });

  it("surfaces unsupported aggregation as a typed DbError (not the base plain Error)", async () => {
    // The full CRUD surface (inserts/reads/update/replace/delete) is implemented
    // in stored mode; what memory genuinely does NOT support is aggregation. It
    // no longer inherits the base adapter's PLAIN-Error throw — it raises a typed
    // DbError so a readable REST controller reports a clean 4xx (see
    // sync-and-caps.spec.ts for the INVALID_QUERY code assertion), not a 500.
    await expect(
      new MemoryAdapter().aggregate({ filter: {}, controls: {} }),
    ).rejects.toBeInstanceOf(DbError);
  });
});
