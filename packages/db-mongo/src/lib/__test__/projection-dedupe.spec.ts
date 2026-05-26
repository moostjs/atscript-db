import { describe, expect, it } from "vite-plus/test";

import { dedupeProjection } from "../projection-dedupe";

describe("dedupeProjection", () => {
  it("strips descendant include when parent is included (Mongo $project rejects parent+leaf with 31249)", () => {
    const input: Record<string, 1> = {
      password: 1,
      "password.hash": 1,
      "password.salt": 1,
      id: 1,
    };
    expect(dedupeProjection(input)).toEqual({ password: 1, id: 1 });
  });

  it("preserves descendant include when parent is NOT included", () => {
    const input: Record<string, 1> = { "password.hash": 1, id: 1 };
    expect(dedupeProjection(input)).toBe(input);
  });

  it("preserves _id: 0 suppression alongside includes", () => {
    const input: Record<string, 0 | 1> = {
      password: 1,
      "password.hash": 1,
      _id: 0,
    };
    expect(dedupeProjection(input)).toEqual({ password: 1, _id: 0 });
  });

  it("returns the same object reference when nothing changes (caller no-op signal)", () => {
    const input: Record<string, 1> = { a: 1, b: 1, c: 1 };
    expect(dedupeProjection(input)).toBe(input);
  });

  it("handles deeply nested descendants under a single parent", () => {
    const input: Record<string, 1> = {
      a: 1,
      "a.b": 1,
      "a.b.c": 1,
      "a.b.c.d": 1,
    };
    expect(dedupeProjection(input)).toEqual({ a: 1 });
  });

  it("does not confuse sibling paths sharing a prefix string", () => {
    const input: Record<string, 1> = { passwordHash: 1, "password.hash": 1 };
    expect(dedupeProjection(input)).toBe(input);
  });

  it("returns input unchanged for exclusion-only projections", () => {
    const input: Record<string, 0> = { password: 0, secrets: 0 };
    expect(dedupeProjection(input)).toBe(input);
  });
});
