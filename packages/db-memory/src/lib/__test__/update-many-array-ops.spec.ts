import type { AtscriptDbTable, DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

let UmaItem: any;
let UmaPair: any;

// `updateMany` with `$insert` / `$upsert` / `$update` / `$remove` (since
// 0.1.182): each matched row ends with the array `updateOne` gives it.

/** Rows with different stored arrays — the third holds none. */
const rows = () => [
  {
    id: 1,
    status: "open",
    tags: ["t1", "old"],
    uniq: ["u"],
    variants: [
      { sku: "a", qty: 1, note: "keep" },
      { sku: "b", qty: 5 },
    ],
    attrs: [{ name: "w", value: "1", unit: "g" }],
    notes: [{ text: "x" }, { text: "y", author: "bob" }],
  },
  {
    id: 2,
    status: "open",
    tags: ["old"],
    uniq: ["v", "w"],
    variants: [{ sku: "c", qty: 3 }],
    attrs: [],
    notes: [{ text: "y", author: "bob" }],
  },
  { id: 3, status: "open", tags: null, uniq: null, variants: null, attrs: null, notes: null },
  { id: 4, status: "closed", tags: ["old"] },
];

const patch = {
  status: "done",
  tags: { $remove: ["old"], $insert: ["new"] },
  uniq: { $insert: ["w", "z"] },
  variants: { $update: [{ sku: "a", qty: 2 }], $insert: [{ sku: "n", qty: 1 }] },
  attrs: { $upsert: [{ name: "w", value: "2" }] },
  notes: { $remove: [{ text: "y", author: "bob" }] },
};

/** The rows of `table` in `id` order. */
const all = async (table: AtscriptDbTable) =>
  (await table.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];

describe("MemoryAdapter — updateMany with array operators", () => {
  let space: DbSpace;
  let items: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ({ UmaItem, UmaPair } = await import("./fixtures/update-many-array-ops.as"));
  });

  beforeEach(async () => {
    space = createTestSpace();
    items = space.getTable(UmaItem);
    await bootstrapStoredTables(space, [UmaItem, UmaPair]);
    await items.insertMany(rows() as any);
  });

  it("every matched row gets its own result — the one updateOne gives it", async () => {
    const result = await items.updateMany({ status: "open" }, patch as any);
    expect(result).toEqual({ matchedCount: 3, modifiedCount: 3 });
    const many = await all(items);

    // the same patch through updateOne, row by row, on a fresh copy
    const other = createTestSpace();
    const table = other.getTable(UmaItem);
    await bootstrapStoredTables(other, [UmaItem]);
    await table.insertMany(rows() as any);
    for (const id of [1, 2, 3]) await table.updateOne({ id, ...patch } as any);
    expect(many).toEqual(await all(table));

    expect(many.map((row) => row.tags)).toEqual([["t1", "new"], ["new"], ["new"], ["old"]]);
    expect(many.map((row) => row.variants)).toEqual([
      [
        { sku: "a", qty: 2 },
        { sku: "b", qty: 5 },
        { sku: "n", qty: 1 },
      ],
      [
        { sku: "c", qty: 3 },
        { sku: "n", qty: 1 },
      ],
      [{ sku: "n", qty: 1 }],
      undefined,
    ]);
    expect(many.map((row) => row.attrs?.[0])).toEqual([
      { name: "w", value: "2", unit: "g" },
      { name: "w", value: "2" },
      { name: "w", value: "2" },
      undefined,
    ]);
    expect(many.map((row) => row.uniq)).toEqual([
      ["u", "w", "z"],
      ["v", "w", "z"],
      ["w", "z"],
      undefined,
    ]);
    expect(many.map((row) => row.notes)).toEqual([[{ text: "x" }], [], [], undefined]);
    // the plain set and the version bump: every matched row, once
    expect(many.map((row) => [row.status, row.version])).toEqual([
      ["done", 1],
      ["done", 1],
      ["done", 1],
      ["closed", 0],
    ]);
  });

  it("a bounded write takes `limit` rows in sort order; looping until 0 patches each row once", async () => {
    const rounds: number[] = [];
    for (;;) {
      const { matchedCount } = await items.updateMany(
        { status: "open" },
        { status: "seen", tags: { $insert: ["x"] } } as any,
        { limit: 2, sort: { id: -1 } },
      );
      rounds.push(matchedCount);
      if (matchedCount === 0) break;
    }
    expect(rounds).toEqual([2, 1, 0]);
    expect((await all(items)).map((row) => row.tags)).toEqual([
      ["t1", "old", "x"],
      ["old", "x"],
      ["x"],
      ["old"],
    ]);
  });

  it("a bounded write picks the first rows in sort order", async () => {
    await items.updateMany({}, { tags: { $insert: ["x"] } } as any, {
      limit: 2,
      sort: { id: -1 },
    });
    expect((await all(items)).map((row) => row.tags)).toEqual([
      ["t1", "old"],
      ["old"],
      ["x"],
      ["old", "x"],
    ]);
  });

  it("a composite primary key", async () => {
    const pairs = space.getTable(UmaPair);
    await pairs.insertMany([
      { org: "a", code: 1, tags: ["x"] },
      { org: "a", code: 2 },
      { org: "b", code: 1, tags: ["y"] },
    ] as any);
    expect(await pairs.updateMany({ org: "a" }, { tags: { $insert: ["n"] } } as any)).toEqual({
      matchedCount: 2,
      modifiedCount: 2,
    });
    const stored = (await pairs.findMany({
      filter: {},
      controls: { $sort: { org: 1, code: 1 } },
    })) as any[];
    expect(stored.map((row) => row.tags)).toEqual([["x", "n"], ["n"], ["y"]]);
  });

  it("zero matches: { 0, 0 } and nothing changes", async () => {
    const before = await all(items);
    expect(await items.updateMany({ status: "none" }, patch as any)).toEqual({
      matchedCount: 0,
      modifiedCount: 0,
    });
    expect(await all(items)).toEqual(before);
  });
});
