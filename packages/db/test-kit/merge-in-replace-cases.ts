import { describe, it, expect } from "vite-plus/test";

import { writes } from "./nested-array-ops-cases";

/**
 * Shared cases (since 0.1.183) for a table built from
 * `fixtures/merge-in-replace.as` (of each adapter): a merge-strategy object
 * inside a replaced (default-strategy) object keeps the children the patch
 * leaves out — "merge stays merge" — while the replaced object's own omitted
 * children are cleared. MongoDB's `updateOne` gave these results before; the
 * SQL and in-memory adapters cleared the merge object's omitted leaves too.
 * A merge-strategy object stored as `null` (or missing), at any depth, gets
 * what the patch sends — MongoDB's `updateMany` threw before 0.1.183. Asserted
 * through `updateOne`, `bulkUpdate` and `updateMany`.
 *
 * A cleared child reads back as `null` on some adapters and is missing on
 * others (the in-memory adapter and a MongoDB `updateMany` store a replaced
 * object without leaf writes as sent), so rows are compared without their
 * `null` properties.
 */

/** A row holding every nested object. */
const mirSeeded = (id: number) => ({
  id,
  label: "l",
  outer: { a: "1", inner: { x: "1", y: "2", tags: ["t"] } },
  mtop: { c: "c", mid: { b: "b", leaf: { x: "1", y: "2" } } },
  rtop: { a: "a", mid: { k: "k", leaf: { x: "1", y: "2" } } },
  deep: { b: "b", r: { a: "a", m: { x: "1", y: "2" } } },
  mm: { c: "c", n: 1, inner: { x: "1", y: "2" } },
  req: { a: "a", inner: { x: "1", y: "2" } },
});

/** [case, stored row (`true`: {@link mirSeeded}), patch, field read back, its expected value] */
const mergeInReplaceCases: Array<
  [string, true | Record<string, unknown>, Record<string, unknown>, string, unknown]
> = [
  [
    "a merge object inside a replaced one keeps its omitted children",
    true,
    { outer: { inner: { x: "9" } } },
    "outer",
    { a: null, inner: { x: "9", y: "2", tags: ["t"] } },
  ],
  [
    "the merge object left out: cleared with the replaced object's other omitted children",
    true,
    { outer: { a: "2" } },
    "outer",
    { a: "2", inner: null },
  ],
  [
    "the merge object set to null: cleared",
    true,
    { outer: { a: "2", inner: null } },
    "outer",
    { a: "2", inner: null },
  ],
  [
    "the merge object sent empty: kept as stored",
    true,
    { outer: { inner: {} } },
    "outer",
    { a: null, inner: { x: "1", y: "2", tags: ["t"] } },
  ],
  [
    "an array operator inside the merge object: its other children stay",
    true,
    { outer: { a: "2", inner: { tags: { $insert: ["u"] } } } },
    "outer",
    { a: "2", inner: { x: "1", y: "2", tags: ["t", "u"] } },
  ],
  [
    "$replace inside the merge object: its other children stay",
    true,
    { outer: { inner: { y: "3", tags: { $replace: ["z"] } } } },
    "outer",
    { a: null, inner: { x: "1", y: "3", tags: ["z"] } },
  ],
  [
    "merge inside replace inside merge",
    true,
    { mtop: { mid: { leaf: { x: "9" } } } },
    "mtop",
    { c: "c", mid: { b: null, leaf: { x: "9", y: "2" } } },
  ],
  [
    "replace inside merge inside replace: the innermost object is replaced",
    true,
    { rtop: { mid: { leaf: { x: "9" } } } },
    "rtop",
    { a: null, mid: { k: "k", leaf: { x: "9", y: null } } },
  ],
  [
    "merge inside replace inside replace",
    true,
    { deep: { r: { m: { x: "9" } } } },
    "deep",
    { b: null, r: { a: null, m: { x: "9", y: "2" } } },
  ],
  [
    "a required merge object inside a replaced one keeps its required child",
    true,
    { req: { inner: { y: "3" } } },
    "req",
    { a: null, inner: { x: "1", y: "3" } },
  ],
  [
    "the replaced object stored as null: the merge object gets what the patch sends",
    { outer: null },
    { outer: { inner: { x: "9" } } },
    "outer",
    { a: null, inner: { x: "9" } },
  ],
  [
    "a merge object inside a merge object keeps its omitted children",
    true,
    { mm: { inner: { x: "9" } } },
    "mm",
    { c: "c", n: 1, inner: { x: "9", y: "2" } },
  ],
  [
    "a top-level merge object stored as null gets what the patch sends",
    { mtop: null },
    { mtop: { c: "x" } },
    "mtop",
    { c: "x" },
  ],
  [
    "a top-level merge object never stored gets what the patch sends",
    {},
    { mtop: { c: "x" } },
    "mtop",
    { c: "x" },
  ],
  [
    "a merge object inside a merge object, stored as null",
    { mm: { c: "c", inner: null } },
    { mm: { inner: { x: "9" } } },
    "mm",
    { c: "c", inner: { x: "9" } },
  ],
  [
    "a merge object inside a merge parent stored as null",
    { mm: null },
    { mm: { inner: { x: "9" } } },
    "mm",
    { inner: { x: "9" } },
  ],
  [
    "a replaced object stored as null inside a merge object, holding a merge object",
    { mtop: { c: "c", mid: null } },
    { mtop: { mid: { leaf: { x: "9" } } } },
    "mtop",
    { c: "c", mid: { b: null, leaf: { x: "9" } } },
  ],
];

/** `value` without its `null` properties (and MongoDB's `_id`), at every depth. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== null && child !== undefined && key !== "_id") out[key] = withoutNulls(child);
  }
  return out;
}

/** The stored row for a case's `seed`. */
const mirRow = (id: number, seed: true | Record<string, unknown>) =>
  seed === true ? mirSeeded(id) : { id, ...seed };

/**
 * Registers the cases. `items` returns the table — empty, created anew for
 * each test (called per case, so a `beforeEach` may set it up).
 */
export function defineMergeInReplaceCases(items: () => any): void {
  describe.each(writes)("%s", (_name, write) => {
    it.each(mergeInReplaceCases)("%s", async (_case, seed, patch, field, expected) => {
      const stored = mirRow(1, seed);
      await items().insertOne(stored);
      await write(items(), 1, patch);
      const row = await items().findOne({ filter: { id: 1 }, controls: {} });
      expect(withoutNulls(row)).toEqual(withoutNulls({ ...stored, [field]: expected }));
    });
  });

  it("updateMany: every row keeps its own merge object's omitted children", async () => {
    await items().insertMany([
      mirSeeded(1),
      { id: 2, outer: { a: "1", inner: { x: "1", y: "other" } } },
      { id: 3, outer: null },
      { id: 4 },
    ]);
    await items().updateMany({}, { outer: { inner: { x: "9" } } });
    const rows = (await items().findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];
    expect(rows.map((row) => withoutNulls(row.outer))).toEqual([
      { inner: { x: "9", y: "2", tags: ["t"] } },
      { inner: { x: "9", y: "other" } },
      { inner: { x: "9" } },
      { inner: { x: "9" } },
    ]);
  });

  it("updateMany: a merge object stored, null or missing per row", async () => {
    await items().insertMany([mirSeeded(1), { id: 2, mtop: null }, { id: 3 }]);
    await items().updateMany({}, { mtop: { c: "x" } });
    const rows = (await items().findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];
    expect(rows.map((row) => withoutNulls(row.mtop))).toEqual([
      { c: "x", mid: { b: "b", leaf: { x: "1", y: "2" } } },
      { c: "x" },
      { c: "x" },
    ]);
  });

  it("a required merge object left out of its replaced parent is rejected", async () => {
    await items().insertOne(mirSeeded(1));
    await expect(items().updateOne({ id: 1, req: { a: "2" } })).rejects.toThrow();
    const row = await items().findOne({ filter: { id: 1 }, controls: {} });
    expect(withoutNulls(row)).toEqual(mirSeeded(1));
  });
}
