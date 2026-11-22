import { describe, it, expect } from "vite-plus/test";

import { withoutNulls } from "./merge-in-replace-cases";
import { writes } from "./nested-array-ops-cases";

/**
 * Shared cases (since 0.1.184) for a table built from
 * `fixtures/merge-whole-value.as` (of each adapter): a merge strategy applies
 * only where a patch reaches the object by its own path. Below an array
 * element, a `@db.json` or `@db.encrypted` field, a union member or a tuple
 * element the merge-strategy object is validated in full — a partial one is
 * rejected, as an insert rejects it — and a full one is stored as sent.
 * Before, the partial object passed validation and was stored as sent,
 * without its required children. The same type (`MwvPrefs`) still merges
 * where a patch reaches it (`prefs`). Asserted through `updateOne`,
 * `bulkUpdate` and `updateMany`.
 */

const GEO = { lat: 1, lng: 2, note: "n" };
const PREFS = { label: "l", geo: GEO };

/** A row holding the merge-strategy object in every placement. */
const seeded = (id: number): Record<string, unknown> => ({
  id,
  prefs: PREFS,
  lines: [{ k: "a", note: "x", geo: GEO }],
  jprefs: PREFS,
  eprefs: PREFS,
  mixed: PREFS,
  union: PREFS,
  pair: [PREFS, 7],
  jset: { a: "1", b: "2" },
  eset: { a: "1", b: "2" },
  x: { name: "n", g: { a: 1, b: 2 } },
  np: PREFS,
  mnp: PREFS,
  outer: { tag: "t", inner: PREFS },
  mouter: { tag: "t", inner: PREFS },
  renamedLines: [{ k: "a", note: "x", geo: GEO }],
});

/**
 * [case, the row's fields replacing the seeded ones (`true`: none), patch,
 * field read back, its value without `null` properties]. A `T | null` is a
 * `T` (since 0.1.184): the merge strategy applies through and on it on every
 * adapter. Before, the in-memory adapter and MongoDB stored such an object
 * whole, so a merge child lost its omitted children (SQLite kept them).
 */
const nullableCases: Array<
  [string, true | Record<string, unknown>, Record<string, unknown>, string, unknown]
> = [
  [
    "an inline `T | null`: its merge child keeps the omitted children",
    true,
    { x: { name: "n2", g: { a: 9 } } },
    "x",
    { name: "n2", g: { a: 9, b: 2 } },
  ],
  [
    "an inline `T | null` stored as null",
    { x: null },
    { x: { name: "n2", g: { a: 9 } } },
    "x",
    { name: "n2", g: { a: 9 } },
  ],
  [
    "an inline `T | null`: a full merge child, the omitted name cleared",
    true,
    { x: { g: { a: 9, b: 8 } } },
    "x",
    { g: { a: 9, b: 8 } },
  ],
  [
    "a named `T | null`: its merge child merges, the omitted label is cleared",
    true,
    { np: { geo: { lat: 9 } } },
    "np",
    { geo: { lat: 9, lng: 2, note: "n" } },
  ],
  [
    "a named `T | null` stored as null",
    { np: null },
    { np: { geo: { lat: 9 } } },
    "np",
    { geo: { lat: 9 } },
  ],
  [
    "a merge-strategy `T | null`: the omitted label is kept",
    true,
    { mnp: { geo: { lat: 9 } } },
    "mnp",
    { label: "l", geo: { lat: 9, lng: 2, note: "n" } },
  ],
  [
    "a merge-strategy `T | null` stored as null",
    { mnp: null },
    { mnp: { geo: { lat: 9 } } },
    "mnp",
    { geo: { lat: 9 } },
  ],
  [
    "`$inc` inside a merge-strategy `T | null`",
    true,
    { mnp: { geo: { lat: { $inc: 1 } } } },
    "mnp",
    { label: "l", geo: { lat: 2, lng: 2, note: "n" } },
  ],
  [
    "a `T | null` under a replaced object",
    true,
    { outer: { inner: { geo: { lat: 9 } } } },
    "outer",
    { inner: { geo: { lat: 9, lng: 2, note: "n" } } },
  ],
  [
    "a `T | null` stored as null under a replaced object",
    { outer: { tag: "t", inner: null } },
    { outer: { inner: { geo: { lat: 9 } } } },
    "outer",
    { inner: { geo: { lat: 9 } } },
  ],
  [
    "a `T | null` under a merge-strategy object",
    true,
    { mouter: { inner: { geo: { lat: 9 } } } },
    "mouter",
    { tag: "t", inner: { geo: { lat: 9, lng: 2, note: "n" } } },
  ],
  [
    "a `T | null` under a merge-strategy object stored as null",
    { mouter: null },
    { mouter: { inner: { geo: { lat: 9 } } } },
    "mouter",
    { inner: { geo: { lat: 9 } } },
  ],
  [
    "`$update` of a merge array renamed with `@db.column`",
    true,
    { renamedLines: { $update: [{ k: "a", note: "y" }] } },
    "renamedLines",
    [{ k: "a", note: "y", geo: GEO }],
  ],
];

/** Field operators where a patch does not reach the object by its own path: refused (`FIELD_OP_CONTEXT`) like one in an array element. */
const refusedOps: Array<[string, Record<string, unknown>]> = [
  ["an array element", { lines: [{ k: "a", geo: { lat: { $inc: 1 }, lng: 2 } }] }],
  ["a tuple element", { pair: [{ geo: { lat: { $inc: 1 }, lng: 2 } }, 3] }],
  ["a union member", { union: { geo: { lat: { $inc: 1 }, lng: 2 } } }],
  ["a replace-strategy `T | null`", { np: { label: "z", geo: { lat: { $inc: 1 } } } }],
];

/** `{ geo: { lat: 5 } }` — `lng` is required. */
const partialGeo = { geo: { lat: 5 } };
const fullGeo = { geo: { lat: 5, lng: 6 } };

/** [whole value, field, partial patch value, full patch value, stored result (default: the full value)] */
const wholeValueCases: Array<[string, string, unknown, unknown, unknown?]> = [
  [
    "an array element (`$update` of a merge array)",
    "lines",
    { $update: [{ k: "a", ...partialGeo }] },
    { $update: [{ k: "a", ...fullGeo }] },
    [{ k: "a", note: "x", ...fullGeo }],
  ],
  ["the whole array", "lines", [{ k: "a", ...partialGeo }], [{ k: "a", ...fullGeo }]],
  ["a @db.json field", "jprefs", partialGeo, fullGeo],
  ["a @db.encrypted field", "eprefs", partialGeo, fullGeo],
  ["a member of a union with a string", "mixed", partialGeo, fullGeo],
  ["a member of a union of objects", "union", partialGeo, fullGeo],
  ["a tuple element", "pair", [partialGeo, 7], [fullGeo, 7]],
];

/**
 * Marks the `@db.json` field `jset` and the `@db.encrypted` field `eset` of
 * `MwvItem` with the merge strategy at runtime — the build refuses the pairs,
 * a type built without the plugin's check does not. Call before the table is
 * first used.
 */
export function mergeOnJsonField(MwvItem: any): void {
  for (const field of ["jset", "eset"]) {
    MwvItem.type.props.get(field).metadata.set("db.patch.strategy", "merge");
  }
}

/**
 * Registers the cases. `items` returns the table — empty, created anew for
 * each test — of a space with an encryption key; `mergeOnJsonField` has run
 * on its type.
 */
export function defineMergeWholeValueCases(items: () => any): void {
  const read = async (id = 1) =>
    withoutNulls(await items().findOne({ filter: { id }, controls: {} })) as Record<string, any>;

  describe.each(writes)("%s", (_name, write) => {
    describe.each(wholeValueCases)("inside %s", (_case, field, partial, full, stored = full) => {
      it("a partial merge-strategy object is rejected, as an insert rejects it", async () => {
        await items().insertOne(seeded(1));
        await expect(write(items(), 1, { [field]: partial })).rejects.toThrow();
        // the inserted value: a `$update` operator's items
        const inserted = (partial as { $update?: unknown }).$update ?? partial;
        await expect(items().insertOne({ id: 2, [field]: inserted })).rejects.toThrow();
        expect((await read())[field]).toEqual(seeded(1)[field]);
      });

      it("a full one is stored as sent", async () => {
        await items().insertOne(seeded(1));
        await write(items(), 1, { [field]: full });
        expect((await read())[field]).toEqual(stored);
      });
    });

    it("the same type still merges where a patch reaches it by its own path", async () => {
      await items().insertOne(seeded(1));
      await write(items(), 1, { prefs: { geo: { lat: 9 } } });
      expect((await read()).prefs).toEqual({ label: "l", geo: { lat: 9, lng: 2, note: "n" } });
    });

    it.each(["jset", "eset"])("%s, with the merge strategy, is replaced whole", async (field) => {
      await items().insertOne(seeded(1));
      await write(items(), 1, { [field]: { a: "9" } });
      expect((await read())[field]).toEqual({ a: "9" });
    });

    it.each(nullableCases)("%s", async (_case, seed, patch, field, expected) => {
      await items().insertOne({ ...seeded(1), ...(seed === true ? {} : seed) });
      await write(items(), 1, patch);
      expect((await read())[field]).toEqual(expected);
    });

    it.each(refusedOps)("a field operator inside %s is refused", async (_case, patch) => {
      await items().insertOne(seeded(1));
      const error = await write(items(), 1, patch).then(
        () => undefined,
        (e: unknown) => e,
      );
      // a union's branches report the reason in its entry's details
      expect(JSON.stringify((error as { errors?: unknown })?.errors)).toContain(
        '"code":"FIELD_OP_CONTEXT"',
      );
    });
  });
}
