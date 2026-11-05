import type { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import type { MemoryAdapter } from "../memory-adapter";
import { caught, createTestSpace, prepareFixtures } from "./test-utils";

// A unique index added over rows that already break it fails, as `CREATE UNIQUE
// INDEX` does on SQL and `createIndex({ unique })` on MongoDB: the index is not
// recorded, the other indexes of the table are, and once the rows are fixed the
// next sync records it.

let fx: Record<string, any>;
let space: DbSpace;

const items = () => space.getTable(fx.IgItem) as any;
const adapter = () => space.getAdapter(fx.IgItem) as MemoryAdapter;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/insert-ignore.as");
});

beforeEach(async () => {
  space = createTestSpace();
  // The table exists, its unique indexes are not recorded yet (a model before them)
  await adapter().ensureTable();
  await items().insertMany([
    { id: 1, sku: "a", pairA: "x", pairB: "y", qty: 1 },
    { id: 2, sku: "a", qty: 1 },
  ]);
});

describe("[memory] unique index over existing duplicates", () => {
  it("syncIndexes rejects naming the index; the indexes that hold are recorded", async () => {
    await expect(adapter().syncIndexes()).rejects.toThrow(
      'Cannot create unique index "sku_idx": stored rows hold duplicate values',
    );
    // pair_idx holds and is enforced; sku_idx is not recorded (no index over duplicates)
    const pair = await caught(
      items().insertOne({ id: 3, sku: "b", pairA: "x", pairB: "y", qty: 1 }),
    );
    expect(pair.errors[0]?.params).toMatchObject({ index: "pair_idx" });
    await items().insertOne({ id: 4, sku: "a", qty: 1 });
    expect(await items().count({ filter: { sku: "a" }, controls: {} })).toBe(3);
  });

  it("once the rows are fixed, the next syncIndexes records and enforces it", async () => {
    await expect(adapter().syncIndexes()).rejects.toThrow();
    await items().deleteOne(2);
    await adapter().syncIndexes();
    const dup = await caught(items().insertOne({ id: 5, sku: "a", qty: 1 }));
    expect(dup.errors[0]?.params).toMatchObject({ index: "sku_idx" });
  });

  it("rows lacking an optional member are not duplicates; repeated syncs record the same set", async () => {
    await items().deleteOne(2);
    // pair_idx members are optional: rows missing one never collide (present-only)
    await items().insertMany([
      { id: 3, sku: "b", qty: 1 },
      { id: 4, sku: "c", qty: 1 },
      { id: 5, sku: "d", pairA: "x", qty: 1 },
      { id: 6, sku: "e", pairA: "x", qty: 1 },
    ]);
    await adapter().syncIndexes();
    await adapter().syncIndexes();
    await items().insertOne({ id: 7, sku: "f", pairA: "x", qty: 1 });
    const pair = await caught(
      items().insertOne({ id: 8, sku: "g", pairA: "x", pairB: "y", qty: 1 }),
    );
    expect(pair.errors[0]?.params).toMatchObject({ index: "pair_idx" });
    const sku = await caught(items().insertOne({ id: 9, sku: "b", qty: 1 }));
    expect(sku.errors[0]?.params).toMatchObject({ index: "sku_idx" });
  });

  it("schema sync reports the table as an error entry and withholds the hash", async () => {
    const result = await syncSchema(space, [fx.IgItem], { onError: "silent" });
    expect(result.status).toBe("failed");
    const entry = result.entries.find((e) => e.name === "ig_items")!;
    expect(entry.status).toBe("error");
    expect(entry.errors.join(" ")).toContain("sku_idx");
    expect((await syncSchema(space, [fx.IgItem], { onError: "silent" })).status).toBe("failed");
  });
});
