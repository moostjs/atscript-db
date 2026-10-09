import type { DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { sortRows } from "../memory-engine";
import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

// NULL placement in sorts (since 0.1.153): `$nulls` puts null / missing values
// first or last whatever the direction; `@db.sort.nulls` is the field default.

let fx: Record<string, any>;
let space: DbSpace;

const t = (): any => space.getTable(fx.SnRow as never);

/** id → amount / closedAt; `undefined` is stored as a missing key. */
const ROWS: Array<{ id: number; grp: string; amount?: number | null; closedAt?: number }> = [
  { id: 1, grp: "a", amount: 30, closedAt: 3 },
  { id: 2, grp: "a", amount: null },
  { id: 3, grp: "b", amount: 10, closedAt: 1 },
  { id: 4, grp: "b" },
  { id: 5, grp: "a", amount: 20, closedAt: 2 },
];

const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

async function readIds(controls: Record<string, unknown>): Promise<number[]> {
  return ids(await t().findMany({ filter: {}, controls }));
}

describe("MemoryAdapter — NULL placement", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/sort-nulls.as");
    space = createTestSpace();
    await bootstrapStoredTables(space, [fx.SnRow]);
    await t().insertMany(ROWS);
  });

  it("keeps nil smallest without $nulls", async () => {
    expect(await readIds({ $sort: { amount: 1 } })).toEqual([2, 4, 3, 5, 1]);
    expect(await readIds({ $sort: { amount: -1 } })).toEqual([1, 5, 3, 4, 2]);
  });

  it("puts null and missing first or last in both directions", async () => {
    expect(await readIds({ $sort: { amount: 1 }, $nulls: { amount: "last" } })).toEqual([
      3, 5, 1, 2, 4,
    ]);
    expect(await readIds({ $sort: { amount: -1 }, $nulls: { amount: "first" } })).toEqual([
      4, 2, 1, 5, 3,
    ]);
    expect(await readIds({ $sort: { amount: 1 }, $nulls: { amount: "first" } })).toEqual([
      2, 4, 3, 5, 1,
    ]);
    expect(await readIds({ $sort: { amount: -1 }, $nulls: { amount: "last" } })).toEqual([
      1, 5, 3, 4, 2,
    ]);
  });

  it("pages across the NULL boundary", async () => {
    const q = { $sort: { amount: 1 }, $nulls: { amount: "last" } };
    expect(await readIds({ ...q, $limit: 2 })).toEqual([3, 5]);
    expect(await readIds({ ...q, $skip: 2, $limit: 2 })).toEqual([1, 2]);
    expect(await readIds({ ...q, $skip: 4, $limit: 2 })).toEqual([4]);
    const { data, count } = await t().findManyWithCount({
      filter: {},
      controls: { ...q, $skip: 1, $limit: 3 },
    });
    expect([ids(data), count]).toEqual([[5, 1, 2], 5]);
    expect((await t().findOne({ filter: {}, controls: { ...q, $skip: 3 } })).id).toBe(2);
  });

  it("applies the @db.sort.nulls default; an explicit entry overrides it", async () => {
    expect(await readIds({ $sort: { closedAt: 1 } })).toEqual([3, 5, 1, 2, 4]);
    expect(await readIds({ $sort: { closedAt: 1 }, $nulls: { closedAt: "first" } })).toEqual([
      2, 4, 3, 5, 1,
    ]);
  });

  it("mixes placed and native keys", async () => {
    expect(await readIds({ $sort: { grp: -1, amount: 1 }, $nulls: { amount: "last" } })).toEqual([
      3, 4, 5, 1, 2,
    ]);
  });

  it("orders grouped rows and first() / last() rows by the placement", async () => {
    const rows = await t().aggregate({
      filter: {},
      controls: {
        $groupBy: ["grp"],
        $select: [
          "grp",
          { $fn: "max", $field: "closedAt", $as: "maxClosed" },
          { $fn: "first", $field: "id", $as: "firstId" },
          { $fn: "last", $field: "id", $as: "lastId" },
        ],
        $rowOrder: { amount: 1 },
        $nulls: { amount: "last", maxClosed: "first" },
        $sort: { maxClosed: 1 },
      },
    });
    // grp b: max closedAt 1; grp a: 3 — no null groups, so plain order
    expect(rows.map((r: any) => r.grp)).toEqual(["b", "a"]);
    const byGrp = Object.fromEntries(rows.map((r: any) => [r.grp, r]));
    // a: amounts 30 (1), null (2), 20 (5) → ordered 5, 1, 2 with nulls last
    expect([byGrp.a.firstId, byGrp.a.lastId]).toEqual([5, 2]);
    // b: 10 (3), missing (4)
    expect([byGrp.b.firstId, byGrp.b.lastId]).toEqual([3, 4]);
  });

  it("reports the capability", () => {
    expect(t().supportsNullsPlacement()).toBe(true);
  });
});

describe("sortRows — nulls", () => {
  const rows = [{ v: 2 }, { v: null }, {}, { v: 1 }];
  it("honours the placement per key", () => {
    expect(sortRows(rows, { v: -1 }, undefined, undefined, { v: "first" })).toEqual([
      { v: null },
      {},
      { v: 2 },
      { v: 1 },
    ]);
    expect(sortRows(rows, { v: 1 }, undefined, undefined, { v: "last" })).toEqual([
      { v: 1 },
      { v: 2 },
      { v: null },
      {},
    ]);
    // the one-pass head selection (topK) agrees with the full sort
    const many = Array.from({ length: 40 }, (_, i) => ({ v: i % 5 === 0 ? null : i }));
    const full = sortRows(many, { v: -1 }, undefined, undefined, { v: "first" });
    expect(sortRows(many, { v: -1 }, undefined, 3, { v: "first" }).slice(0, 3)).toEqual(
      full.slice(0, 3),
    );
  });
});
