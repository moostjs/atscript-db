import { describe, it, expect } from "vite-plus/test";
import { reachable, topoOrder } from "../schema/dependency-order";

/** Position of `name` in the flattened order. */
function pos(order: string[][], name: string): number {
  return order.flat().indexOf(name);
}

describe("topoOrder", () => {
  it("places dependencies (parents) before dependents (children)", () => {
    // task → project → user (child → parent)
    const order = topoOrder(
      ["task", "user", "project"],
      [
        ["task", "project"],
        ["project", "user"],
      ],
    );
    expect(pos(order, "user")).toBeLessThan(pos(order, "project"));
    expect(pos(order, "project")).toBeLessThan(pos(order, "task"));
    expect(order.every((g) => g.length === 1)).toBe(true);
  });

  it("is a pure function of the graph — independent of input order", () => {
    const edges: Array<[string, string]> = [
      ["issue", "team"],
      ["issue", "channel"],
      ["channel", "team"],
      ["path", "issue"],
    ];
    const a = topoOrder(["path", "issue", "team", "channel"], edges);
    const b = topoOrder(["team", "channel", "issue", "path"], edges.toReversed());
    expect(a).toEqual(b);
    expect(pos(a, "team")).toBeLessThan(pos(a, "channel"));
    expect(pos(a, "channel")).toBeLessThan(pos(a, "issue"));
    expect(pos(a, "issue")).toBeLessThan(pos(a, "path"));
  });

  it("sorts independent nodes by name", () => {
    expect(topoOrder(["zeta", "alpha", "mid"], [])).toEqual([["alpha"], ["mid"], ["zeta"]]);
  });

  it("groups a mutual dependency (A ⇄ B) into one name-sorted SCC", () => {
    const order = topoOrder(
      ["cycle_b", "cycle_a", "other"],
      [
        ["cycle_a", "cycle_b"],
        ["cycle_b", "cycle_a"],
        ["other", "cycle_a"],
      ],
    );
    const group = order.find((g) => g.length > 1);
    expect(group).toEqual(["cycle_a", "cycle_b"]);
    expect(order.filter((g) => g.length > 1)).toHaveLength(1);
    // `other` depends on the cycle → comes after it
    expect(order.indexOf(group!)).toBeLessThan(order.findIndex((g) => g[0] === "other"));
  });

  it("handles a longer cycle plus a tail", () => {
    const order = topoOrder(
      ["a", "b", "c", "d"],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
        ["a", "d"],
      ],
    );
    expect(order).toEqual([["d"], ["a", "b", "c"]]);
  });

  it("ignores self-loops (self-referential FK)", () => {
    expect(topoOrder(["category"], [["category", "category"]])).toEqual([["category"]]);
  });

  it("ignores edges to nodes outside the set (external tables)", () => {
    expect(topoOrder(["child"], [["child", "unmanaged_parent"]])).toEqual([["child"]]);
  });

  it("deduplicates repeated node names and edges", () => {
    const order = topoOrder(
      ["a", "a", "b"],
      [
        ["a", "b"],
        ["a", "b"],
      ],
    );
    expect(order).toEqual([["b"], ["a"]]);
  });

  it("reversing the order yields children before parents (drop order)", () => {
    const order = topoOrder(
      ["parent", "child", "grandchild"],
      [
        ["child", "parent"],
        ["grandchild", "child"],
      ],
    );
    expect(order.toReversed().flat()).toEqual(["grandchild", "child", "parent"]);
  });

  it("returns an empty order for no nodes", () => {
    expect(topoOrder([], [])).toEqual([]);
  });
});

describe("reachable", () => {
  // grandchild → child → parent, other → parent, bystander → elsewhere
  const edges: Array<[string, string]> = [
    ["child", "parent"],
    ["grandchild", "child"],
    ["other", "parent"],
    ["bystander", "elsewhere"],
  ];

  it("returns the seeds plus every node that depends on them, transitively", () => {
    expect([...reachable(["parent"], edges)].toSorted()).toEqual([
      "child",
      "grandchild",
      "other",
      "parent",
    ]);
    expect([...reachable(["child"], edges)].toSorted()).toEqual(["child", "grandchild"]);
    expect([...reachable(["grandchild"], edges)]).toEqual(["grandchild"]);
  });

  it("is independent of edge order and empty for no seeds", () => {
    expect([...reachable(["parent"], edges.toReversed())].toSorted()).toEqual([
      "child",
      "grandchild",
      "other",
      "parent",
    ]);
    expect(reachable([], edges).size).toBe(0);
  });
});
