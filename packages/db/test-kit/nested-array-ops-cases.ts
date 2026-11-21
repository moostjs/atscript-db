import { describe, it, expect } from "vite-plus/test";

/**
 * Shared cases (since 0.1.182) for a table built from
 * `fixtures/nested-array-ops.as` (of each adapter): array operators on an
 * array inside a nested object, at every depth and for both patch strategies
 * of the parents, through `updateOne`, `bulkUpdate` and `updateMany`. The
 * results are what SQLite gives for the same patch — the in-memory adapter
 * matches them since 0.1.182.
 */

/** A row holding `["x"]` in every nested array. */
const seeded = (id: number) => ({
  id,
  box: { caption: "c", labels: ["x"] },
  mbox: { caption: "c", labels: ["x"] },
  outer: { title: "t", inner: { note: "n", labels: ["x"] }, minner: { note: "n", labels: ["x"] } },
  mouter: { inner: { note: "n", lines: [{ k: "a", v: 1 }] } },
});

/** [case, seeded? (or the row's other fields), patch, field read back, its expected value] */
const cases: Array<
  [string, boolean | Record<string, unknown>, Record<string, unknown>, string, unknown]
> = [
  [
    "replace-strategy object: the omitted optional child is cleared",
    true,
    { box: { labels: { $insert: ["y"] } } },
    "box",
    { caption: null, labels: ["x", "y"] },
  ],
  [
    "merge-strategy object: the stored items stay, the siblings too",
    true,
    { mbox: { labels: { $insert: ["y"] } } },
    "mbox",
    { caption: "c", labels: ["x", "y"] },
  ],
  [
    "replace inside replace: every omitted optional child cleared, two levels down",
    true,
    { outer: { inner: { labels: { $remove: ["x"] } } } },
    "outer",
    { title: null, inner: { note: null, labels: [] }, minner: null },
  ],
  [
    "a merge-strategy object inside a replaced one: its omitted optional leaves are cleared too",
    true,
    { outer: { title: "t2", minner: { labels: { $insert: ["y"] } } } },
    "outer",
    { title: "t2", inner: null, minner: { note: null, labels: ["x", "y"] } },
  ],
  [
    "a replace-strategy object inside a merge one: keyed $upsert",
    true,
    {
      mouter: {
        inner: {
          lines: {
            $upsert: [
              { k: "a", v: 2 },
              { k: "b", v: 1 },
            ],
          },
        },
      },
    },
    "mouter",
    {
      inner: {
        note: null,
        lines: [
          { k: "a", v: 2 },
          { k: "b", v: 1 },
        ],
      },
    },
  ],
  [
    "a missing replace-strategy object: the operator starts from an empty array",
    false,
    { box: { labels: { $insert: ["y"] } } },
    "box",
    { caption: null, labels: ["y"] },
  ],
  [
    "a leaf set next to an operator that has nothing to apply",
    true,
    { box: { caption: "d", labels: { $update: ["x"] } } },
    "box",
    { caption: "d", labels: ["x"] },
  ],
  [
    "a missing merge-strategy object: the operator starts from an empty array",
    false,
    { mbox: { labels: { $insert: ["y"] } } },
    "mbox.labels",
    ["y"],
  ],
  [
    "$replace inside a replace-strategy object",
    true,
    { box: { caption: "c", labels: { $replace: ["z"] } } },
    "box",
    { caption: "c", labels: ["z"] },
  ],
  [
    "$replace alone inside a replace-strategy object stored as null",
    { box: null },
    { box: { labels: { $replace: ["z"] } } },
    "box",
    { caption: null, labels: ["z"] },
  ],
  [
    "an operator inside a replace-strategy object stored as null",
    { box: null },
    { box: { labels: { $insert: ["y"] } } },
    "box",
    { caption: null, labels: ["y"] },
  ],
  [
    "$replace inside a merge-strategy object inside a replaced one",
    true,
    { outer: { title: "t2", minner: { labels: { $replace: ["z"] } } } },
    "outer",
    { title: "t2", inner: null, minner: { note: null, labels: ["z"] } },
  ],
];

type TWrite = (table: any, id: number, patch: Record<string, unknown>) => Promise<unknown>;
const writes: Array<[string, TWrite]> = [
  ["updateOne", (table, id, patch) => table.updateOne({ id, ...patch })],
  ["bulkUpdate", (table, id, patch) => table.bulkUpdate([{ id, ...patch }])],
  ["updateMany", (table, id, patch) => table.updateMany({ id }, patch)],
];

const at = (row: Record<string, any>, path: string) =>
  path.split(".").reduce<any>((value, segment) => value?.[segment], row);

/**
 * Registers the cases. `items` returns the table — empty, created anew for
 * each test (called per case, so a `beforeEach` may set it up).
 */
export function defineNestedArrayOpsCases(items: () => any): void {
  describe.each(writes)("%s", (_name, write) => {
    it.each(cases)("%s", async (_case, seed, patch, field, expected) => {
      await items().insertOne(seed === true ? seeded(1) : { id: 1, ...(seed || undefined) });
      await write(items(), 1, patch);
      const row = await items().findOne({ filter: { id: 1 }, controls: {} });
      expect(at(row, field)).toEqual(expected);
    });
  });

  it("updateMany: every row from its own nested arrays", async () => {
    await items().insertMany([
      { id: 1, box: { labels: ["a"] }, mbox: { caption: "c", labels: ["a", "b"] } },
      { id: 2, box: { labels: [] }, mbox: { labels: ["b"] } },
      { id: 3 },
    ]);
    await items().updateMany(
      {},
      { box: { labels: { $insert: ["n"] } }, mbox: { labels: { $remove: ["b"] } } },
    );
    const rows = (await items().findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];
    expect(rows.map((row) => row.box)).toEqual([
      { caption: null, labels: ["a", "n"] },
      { caption: null, labels: ["n"] },
      { caption: null, labels: ["n"] },
    ]);
    expect(rows.map((row) => row.mbox?.labels)).toEqual([["a"], [], []]);
    expect(rows[0].mbox.caption).toBe("c");
  });
}
