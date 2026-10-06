import { describe, it, expect } from "vite-plus/test";

import type { TDecorationIndex } from "../decorations/decoration-index";
import { DecorationPlanner, stripDecorations } from "../decorations/decoration-planner";

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

describe("DecorationPlanner: a client-selected descendant of a required path", () => {
  const p = () => planner({ d: ["address"] });
  const row = () => ({
    id: 1,
    address: { city: "X", zip: "1", geo: { lat: 1, lng: 2 } },
    d: "decor",
  });
  /** The plan, then the strip after the hook (the whole `address` was read). */
  const stripped = (select: unknown) => {
    const planner = p();
    const plan = planner.plan(select);
    const read = planner.serve(plan, null);
    const out = row();
    stripDecorations([out], read);
    return { plan, out };
  };

  it("an inclusion list keeps the selected child and drops the rest of the parent", () => {
    const { plan, out } = stripped(["id", "address.city", "d"]);
    expect(plan.requiresOnly).toEqual(["address"]);
    expect(out.address).toEqual({ city: "X" });
    expect(out.id).toBe(1);
  });

  it("an inclusion map behaves the same, and nested descendants survive whole", () => {
    expect(stripped({ id: 1, "address.city": 1, d: 1 }).out.address).toEqual({ city: "X" });
    const { out } = stripped(["address.geo.lat", "address.city", "d"]);
    expect(out.address).toEqual({ city: "X", geo: { lat: 1 } });
  });

  it("selecting the parent itself keeps it whole", () => {
    const { plan, out } = stripped(["address", "d"]);
    expect(plan.requiresOnly).toEqual([]);
    expect(out.address).toEqual(row().address);
  });

  it("without a client selection under the parent the whole parent is stripped", () => {
    expect(stripped(["id", "d"]).out.address).toBeUndefined();
  });

  it("an exclusion map of a descendant is un-excluded for the hook and only that descendant is stripped", () => {
    const { plan, out } = stripped({ "address.zip": 0 });
    expect(plan.select).toBeUndefined();
    expect(plan.requiresOnly).toEqual(["address.zip"]);
    const { zip: _zip, ...rest } = row().address;
    expect(out.address).toEqual(rest);
  });
});
