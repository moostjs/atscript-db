import { describe, expect, it } from "vite-plus/test";

import { hasAncestorIn } from "../path-utils";

describe("hasAncestorIn", () => {
  it("returns false for a root-level path (no ancestors)", () => {
    expect(hasAncestorIn("groupContact", new Set(["groupContact"]))).toBe(false);
  });

  it("detects an immediate parent", () => {
    expect(hasAncestorIn("groupContact.email", new Set(["groupContact"]))).toBe(true);
  });

  it("detects a non-immediate (gapped) ancestor", () => {
    // `a` is in the set but the intermediate `a.b` is not — still a match.
    expect(hasAncestorIn("a.b.c", new Set(["a"]))).toBe(true);
  });

  it("checks every dot-boundary ancestor, not just the first", () => {
    expect(hasAncestorIn("a.b.c.d", new Set(["a.b.c"]))).toBe(true);
  });

  it("does not treat the path itself as its own ancestor", () => {
    expect(hasAncestorIn("a.b", new Set(["a.b"]))).toBe(false);
  });

  // The documented boundary trap: ancestors are sliced on real dot boundaries,
  // so `a.bc` is NOT a child of `a.b` even though it shares the `a.b` string prefix.
  // A naive startsWith(ancestor) (without the trailing dot) would wrongly match here.
  it("does not treat a same-level sibling sharing a string prefix as a child", () => {
    expect(hasAncestorIn("a.bc", new Set(["a.b"]))).toBe(false);
    expect(hasAncestorIn("groupContactExtra", new Set(["groupContact"]))).toBe(false);
  });
});
