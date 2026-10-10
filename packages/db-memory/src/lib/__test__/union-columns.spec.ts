import type { DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

// `T | null` and unions of objects (since 0.1.155): the reads, nested-path
// filters and sorts the relational adapters give (`union-columns.spec.ts` there).

let fx: Record<string, any>;
let space: DbSpace;

const t = (): any => space.getTable(fx.UcOrder as never);
const card = { kind: "card", card: "4111", amount: 10 };
const bank = { kind: "bank", iban: "DE89", amount: 20 };
const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

describe("MemoryAdapter — union fields", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/union-columns.as");
    space = createTestSpace();
    await bootstrapStoredTables(space, [fx.UcOrder]);
    await t().insertMany([
      { id: 1, qty: null, payment: card, refund: null, extra: "x" },
      { id: 2, qty: 5, payment: bank, refund: bank, extra: card },
    ]);
  });

  it("reads null and the stored member back", async () => {
    expect(await t().findMany({ filter: {}, controls: { $sort: { id: 1 } } })).toEqual([
      { id: 1, qty: null, payment: card, refund: null, extra: "x" },
      { id: 2, qty: 5, payment: bank, refund: bank, extra: card },
    ]);
  });

  it("filters and sorts by a nested path of a union of objects", async () => {
    expect(ids(await t().findMany({ filter: { "payment.card": "4111" } }))).toEqual([1]);
    expect(ids(await t().findMany({ filter: { "refund.iban": "DE89" } }))).toEqual([2]);
    expect(ids(await t().findMany({ filter: { "refund.kind": null } }))).toEqual([1]);
    expect(
      ids(await t().findMany({ filter: {}, controls: { $sort: { "payment.amount": -1 } } })),
    ).toEqual([2, 1]);
  });

  it("switching the member by patch replaces the object", async () => {
    await t().updateOne({ id: 1, payment: bank, refund: card });
    expect(await t().findOne({ filter: { id: 1 } })).toEqual({
      id: 1,
      qty: null,
      payment: bank,
      refund: card,
      extra: "x",
    });
  });

  it("a unique index over a `| null` field lets several rows hold null", async () => {
    await bootstrapStoredTables(space, [fx.UcCoded]);
    const coded = space.getTable(fx.UcCoded as never) as any;
    await coded.insertMany([
      { id: 1, code: null },
      { id: 2, code: null },
      { id: 3, code: "A" },
    ]);
    await expect(coded.insertOne({ id: 4, code: "A" })).rejects.toThrow();
  });

  it("null tests on an object: none of its fields holds a value", async () => {
    await bootstrapStoredTables(space, [fx.UcNote]);
    const notes = space.getTable(fx.UcNote as never) as any;
    await notes.insertMany([
      { id: 1, meta: {} },
      { id: 2, meta: { tag: "x" } },
      { id: 3 },
      { id: 4, meta: { tag: null } },
    ]);
    const noteIds = async (filter: Record<string, unknown>) =>
      ids(await notes.findMany({ filter, controls: { $sort: { id: 1 } } }));
    expect(await noteIds({ meta: null })).toEqual([1, 3, 4]);
    expect(await noteIds({ meta: { $ne: null } })).toEqual([2]);
    expect(await noteIds({ meta: { $exists: true } })).toEqual([2]);
  });
});
