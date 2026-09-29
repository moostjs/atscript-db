import { DbError, DocumentFieldMapper } from "@atscript/db";
import type { AtscriptDbTable, DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

// `@db.column.derived` on the memory adapter (since 0.1.141): a document
// adapter — nothing stored, reads filled from the source path, queries and
// the unique index address the source path.

let DvOrder: any;

const ROWS = [
  {
    id: 1,
    status: "open",
    payload: { customer: { id: "c1", vip: true, tier: "Gold" }, total: 10 },
    meta: { region: "eu" },
  },
  { id: 2, status: "paid", payload: { customer: { id: "c2", vip: false }, total: 5 } },
  {
    id: 3,
    status: "open",
    payload: { customer: { id: "c1", vip: true }, total: 7 },
    meta: { region: "us" },
  },
];

describe("MemoryAdapter: derived columns", () => {
  let space: DbSpace;
  let orders: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ({ DvOrder } = await import("./fixtures/derived.as"));
  });

  beforeEach(async () => {
    space = createTestSpace();
    orders = space.getTable(DvOrder);
    await bootstrapStoredTables(space, [DvOrder]);
    await orders.insertMany(
      ROWS.map((r) => Object.assign({}, r, { customerId: "zzz", amount: 999 })) as never,
    );
  });

  it("fills the derived fields on read, stores nothing for them", async () => {
    const rows = (await orders.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];
    expect(rows[0]).toEqual({
      id: 1,
      status: "open",
      payload: { customer: { id: "c1", vip: true, tier: "Gold" }, total: 10 },
      meta: { region: "eu" },
      customerId: "c1",
      vip: true,
      amount: 10,
      region: "eu",
      tier: "Gold",
    });
    expect(rows[1]).toMatchObject({ customerId: "c2", region: null, tier: null });
    const only = await orders.findOne({
      filter: { id: 1 },
      controls: { $select: ["id", "customerId"] },
    });
    expect(only).toEqual({ id: 1, customerId: "c1" });
  });

  it("filters, sorts, groups on the derived field and enforces its unique index", async () => {
    const filtered = await orders.findMany({
      filter: { customerId: "c1", vip: true },
      controls: { $sort: { amount: -1 }, $select: ["id", "amount"] },
    });
    expect(filtered).toEqual([
      { id: 1, amount: 10 },
      { id: 3, amount: 7 },
    ]);
    const grouped = await orders.aggregate({
      filter: {},
      controls: {
        $groupBy: ["customerId"],
        $select: ["customerId", { $fn: "sum", $field: "amount", $as: "total" }],
        $sort: { customerId: 1 },
      },
    } as never);
    expect(grouped).toEqual([
      { customerId: "c1", total: 17 },
      { customerId: "c2", total: 5 },
    ]);

    // The raw controls the mapper receives may carry the single-string
    // `$groupBy` form the path guard accepts — it fills the derived field
    // too (regression: the string branch used to be skipped)
    const raw = [
      { payload: { customer: { id: "c1" } }, total: 17 },
      { payload: { customer: { id: "c2" } }, total: 5 },
    ];
    expect(
      new DocumentFieldMapper().reconstructRows(raw, orders.getMetadata(), {
        $groupBy: "customerId",
        $select: ["customerId", { $fn: "sum", $field: "amount", $as: "total" }],
      }),
    ).toEqual([
      { customerId: "c1", total: 17 },
      { customerId: "c2", total: 5 },
    ]);

    let conflict: unknown;
    try {
      await orders.insertOne({
        id: 4,
        status: "x",
        payload: { customer: { id: "c4", vip: false }, total: 1 },
        meta: { region: "eu" },
      } as never);
    } catch (e) {
      conflict = e;
    }
    expect(conflict).toBeInstanceOf(DbError);
    expect((conflict as DbError).code).toBe("CONFLICT");
  });
});
