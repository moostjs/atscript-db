import { describe, it, expect, beforeAll } from "vite-plus/test";

import { decomposePatch } from "../patch/patch-decomposer";
import { AtscriptDbTable } from "../table/db-table";
import type { TDbUpdateOptions, TDbUpdateResult } from "../types";
import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

// A merge-strategy object inside a replaced (default-strategy) one keeps the
// children the patch leaves out — what MongoDB's update pipeline does — while
// the replaced object's own omitted children are cleared (since 0.1.183;
// before, the flattening adapters nulled the merge object's omitted columns
// too, and a nested-object adapter stored the replaced object as sent).

let MirItem: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ MirItem } = await import("./fixtures/merge-in-replace.as"));
});

/** [case, patch, keys on a flattening adapter, keys on a nested-object adapter] */
const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, unknown]> = [
  [
    "a merge object inside a replaced one: its omitted children are not written",
    { outer: { inner: { x: "9" } } },
    { "outer.inner.x": "9", "outer.a": null },
    { "outer.a": null, "outer.inner.x": "9" },
  ],
  [
    "the merge object left out: cleared with the other omitted children",
    { outer: { a: "2" } },
    {
      "outer.a": "2",
      "outer.inner.x": null,
      "outer.inner.y": null,
      "outer.inner.tags": null,
    },
    { outer: { a: "2" } },
  ],
  [
    "the merge object set to null: cleared",
    { outer: { a: "2", inner: null } },
    {
      "outer.a": "2",
      "outer.inner.x": null,
      "outer.inner.y": null,
      "outer.inner.tags": null,
    },
    { outer: { a: "2", inner: null } },
  ],
  [
    "the merge object sent empty: nothing of it is written",
    { outer: { inner: {} } },
    { "outer.a": null },
    { "outer.a": null },
  ],
  [
    "an array operator inside the merge object",
    { outer: { inner: { tags: { $insert: ["u"] } } } },
    { "outer.inner.tags.__$insert": ["u"], "outer.a": null },
    { "outer.a": null, "outer.inner.tags.__$insert": ["u"] },
  ],
  [
    "merge inside replace inside merge: the merge parent's other children untouched",
    { mtop: { mid: { leaf: { x: "9" } } } },
    { "mtop.mid.leaf.x": "9", "mtop.mid.b": null },
    { "mtop.mid.b": null, "mtop.mid.leaf.x": "9" },
  ],
  [
    "replace inside merge inside replace: the innermost object is replaced",
    { rtop: { mid: { leaf: { x: "9" } } } },
    { "rtop.mid.leaf.x": "9", "rtop.mid.leaf.y": null, "rtop.a": null },
    { "rtop.a": null, "rtop.mid.leaf": { x: "9" } },
  ],
  [
    "merge inside replace inside replace: both replaced objects clear their own children",
    { deep: { r: { m: { x: "9" } } } },
    { "deep.r.m.x": "9", "deep.r.a": null, "deep.b": null },
    { "deep.b": null, "deep.r.a": null, "deep.r.m.x": "9" },
  ],
  [
    "a required merge object inside a replaced one: its required child is not nulled",
    { req: { inner: { y: "3" } } },
    { "req.inner.y": "3", "req.a": null },
    { "req.a": null, "req.inner.y": "3" },
  ],
];

describe("decomposePatch — a merge-strategy object inside a replaced one", () => {
  it.each(cases)("flattening adapter: %s", (_case, patch, flat) => {
    const table = new AtscriptDbTable(MirItem, new MockAdapter());
    expect(decomposePatch(patch, table as any)).toEqual(flat);
  });

  it.each(cases)("nested-object adapter: %s", (_case, patch, _flat, nested) => {
    const table = new AtscriptDbTable(MirItem, new NestedMockAdapter());
    expect(decomposePatch(patch, table as any)).toEqual(nested);
  });

  it("a merge object at the top level still writes only what the patch gives", () => {
    for (const adapter of [new MockAdapter(), new NestedMockAdapter()]) {
      const table = new AtscriptDbTable(MirItem, adapter);
      expect(decomposePatch({ mtop: { c: "x" } }, table as any)).toEqual({ "mtop.c": "x" });
    }
  });
});

/** The write calls an `updateMany` made. */
const writeCalls = (adapter: MockAdapter) =>
  adapter.calls
    .map((call) => call.method)
    .filter((m) => m === "nativePatchMany" || m === "updateMany");

describe("updateMany — native-patch adapter", () => {
  class NativeManyAdapter extends NestedMockAdapter {
    override supportsNativePatch(): boolean {
      return true;
    }
    override async nativePatchMany(
      filter: any,
      patch: unknown,
      ops?: any,
      opts?: TDbUpdateOptions,
    ): Promise<TDbUpdateResult> {
      this.record("nativePatchMany", filter, patch, ops, opts);
      return { matchedCount: 1, modifiedCount: 1 };
    }
  }

  // A classic update cannot create a field inside an object stored as `null`
  // (MongoDB refuses it), and the outer object set whole loses a merge
  // object's other children: every write of a field inside an embedded object
  // takes the update pipeline `updateOne` uses (since 0.1.183)
  it.each([
    ["a merge object inside a replaced object", { outer: { inner: { x: "9" } } }],
    [
      "a merge object inside a replaced one inside a merge one",
      { mtop: { mid: { leaf: { x: "9" } } } },
    ],
    ["a merge object two replaced objects down", { deep: { r: { m: { x: "9" } } } }],
    ["a merge object at the top level", { mtop: { c: "x" } }],
    ["a merge object inside a merge one", { mm: { inner: { x: "9" } } }],
    ["a field operator inside a merge object", { mm: { n: { $inc: 2 } } }],
  ])("%s takes nativePatchMany", async (_where, patch) => {
    const adapter = new NativeManyAdapter();
    const table = new AtscriptDbTable(MirItem, adapter);
    await table.updateMany({ id: 1 }, patch as any);
    expect(writeCalls(adapter)).toEqual(["nativePatchMany"]);
    expect(adapter.calls.find((c) => c.method === "nativePatchMany")!.args[1]).toEqual(patch);
  });

  it.each([
    ["a top-level field", { label: "x" }],
    ["a replaced object without a merge object", { outer: { a: "2" } }],
    ["a merge object set to null", { outer: { inner: null } }],
    ["a merge object set to null at the top level", { mtop: null }],
  ])("%s takes the plain updateMany", async (_where, patch) => {
    const adapter = new NativeManyAdapter();
    const table = new AtscriptDbTable(MirItem, adapter);
    await table.updateMany({ id: 1 }, patch as any);
    expect(writeCalls(adapter)).toEqual(["updateMany"]);
  });

  it("an empty merge object writes nothing", async () => {
    const adapter = new NativeManyAdapter();
    const table = new AtscriptDbTable(MirItem, adapter);
    await table.updateMany({ id: 1 }, { mtop: {} } as any);
    expect(writeCalls(adapter)).toEqual([]);
  });
});
