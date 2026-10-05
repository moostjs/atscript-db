import { describe, it, expect } from "vite-plus/test";

import type { TDecorationIndex } from "../decorations/decoration-index";
import { DecorationPlanner } from "../decorations/decoration-planner";

/** Nested `requires` paths: only what is read SOLELY for a decoration is stripped again. */

function planner(requires: Record<string, string[]>) {
  const keys = Object.keys(requires);
  const index: TDecorationIndex = {
    type: {} as never,
    keys,
    keySet: new Set(keys),
    requires: new Map(Object.entries(requires)),
    memo: { meta: new WeakMap() },
  };
  return new DecorationPlanner(index, {
    isVisible: () => true,
    capabilities: () => ({ decorationVisible: () => true }) as never,
    preferred: new Set(["id"]),
    scoped: false,
    firstVisibleField: () => "id",
  });
}

describe("DecorationPlanner nested requires", () => {
  const p = () => planner({ d: ["address.city"] });

  it("a selected parent keeps the required child (not stripped)", () => {
    const plan = p().plan(["address", "d"]);
    expect(plan.select).toEqual(["address"]);
    expect(plan.requiresOnly).toEqual([]);
  });

  it("an unselected parent: the child is read and stripped again", () => {
    const plan = p().plan(["id", "d"]);
    expect(plan.select).toEqual(["id", "address.city"]);
    expect(plan.requiresOnly).toEqual(["address.city"]);
  });

  it("a selected sibling child is the client's, not stripped", () => {
    const plan = p().plan(["address.city", "d"]);
    expect(plan.select).toEqual(["address.city"]);
    expect(plan.requiresOnly).toEqual([]);
  });

  it("exclusion map: an excluded parent is un-excluded for the hook and stripped", () => {
    const plan = p().plan({ address: 0 });
    expect(plan.requested).toEqual(["d"]);
    expect(plan.select).toBeUndefined();
    expect(plan.requiresOnly).toEqual(["address"]);
  });

  it("exclusion map: other exclusions stay", () => {
    const plan = p().plan({ address: 0, secret: 0 });
    expect(plan.select).toEqual({ secret: 0 });
    expect(plan.requiresOnly).toEqual(["address"]);
  });
});
