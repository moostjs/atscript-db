import { DbError } from "@atscript/db";
import type { AtscriptDbTable, DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

let ApOrder: any;

// Embedded-array `$update` items share the plain array's optional/null rules:
// `null` clears an optional item field; a non-optional one still rejects, with
// the error at the item prop path.
describe("MemoryAdapter — embedded array $update item validation", () => {
  let space: DbSpace;
  let orders: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ApOrder = (await import("./fixtures/array-patch-items.as")).ApOrder;
  });

  beforeEach(async () => {
    space = createTestSpace();
    orders = space.getTable(ApOrder);
    await bootstrapStoredTables(space, [ApOrder]);
    await orders.insertOne({
      id: 1,
      title: "o1",
      items: [
        { sku: "a", qty: 1, note: "gift" },
        { sku: "b", qty: 2, note: "keep" },
      ],
    } as any);
  });

  const read = async () => (await orders.findOne({ filter: { id: 1 }, controls: {} })) as any;

  it("updateOne $update sets an optional item field to null", async () => {
    await orders.updateOne({
      id: 1,
      items: { $update: [{ sku: "a", qty: 1, note: null }] },
    } as any);
    const row = await read();
    expect(row.items).toEqual([
      { sku: "a", qty: 1, note: null },
      { sku: "b", qty: 2, note: "keep" },
    ]);
  });

  it("updateOne $update rejects null on a non-optional item field at the item path", async () => {
    const err = await orders
      .updateOne({ id: 1, items: { $update: [{ sku: "a", qty: null }] } } as any)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as DbError).errors).toEqual([
      expect.objectContaining({ path: "items.$update[0].qty" }),
    ]);
    expect((await read()).items[0]).toEqual({ sku: "a", qty: 1, note: "gift" });
  });
});
