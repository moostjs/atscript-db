import { describe, expect, it, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";
import {
  checkBoundedCascade,
  checkBoundedComposite,
  checkBoundedRace,
  checkBoundedWrites,
  checkBulkValidation,
  checkOnUpdateInc,
  type TBulkWriteTables,
} from "./bulk-writes-check";

// The memory adapter has no native bounded writes: the core reads the first
// keys in order, then writes filter AND keys; cascades are application-level
// and pin the keys first (since 0.1.162).

let fx: Record<string, any>;
let t: TBulkWriteTables;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/bulk-writes.as");
});

beforeEach(async () => {
  const space = createTestSpace();
  await bootstrapStoredTables(space, [fx.BwTask, fx.BwOwner, fx.BwItem]);
  t = {
    tasks: space.getTable(fx.BwTask),
    owners: space.getTable(fx.BwOwner),
    items: space.getTable(fx.BwItem),
  };
});

describe("MemoryAdapter — bounded writes, @db.onUpdate.inc, validated bulk payloads", () => {
  it("@db.onUpdate.inc moves on every write path; touchMany stamps @db.onUpdate.now", () =>
    checkOnUpdateInc(t));
  it("updateMany / replaceMany validate their payload", () => checkBulkValidation(t));
  it("bounded updateMany / deleteMany (core emulation)", () => checkBoundedWrites(t));
  it("a bounded write that loses its picked rows to a concurrent writer retries while matches remain", () =>
    checkBoundedRace(t.tasks));
  it("a bounded delete with an application-level cascade pins the keys first", () =>
    checkBoundedCascade(t));
  it("a bounded cascade delete leaves a picked row a concurrent writer moved out of the filter", async () => {
    await t.owners.insertMany([1, 2, 3].map((id) => ({ id, name: "old" })));
    await t.items.insertMany([
      { id: 1, label: "a", ownerId: 1 },
      { id: 2, label: "b", ownerId: 2 },
    ]);
    const adapter = t.owners.getAdapter() as any;
    const own = adapter.findMany;
    let moved = false;
    // The "concurrent writer" renames owner 1 right after the pick read its key.
    adapter.findMany = async (query: any) => {
      const rows = await own.call(adapter, query);
      if (!moved && query.controls?.$limit === 2) {
        moved = true;
        await adapter.updateMany({ id: 1 }, { name: "new" });
      }
      return rows;
    };
    try {
      expect(await t.owners.deleteMany({ name: "old" }, { limit: 2 })).toEqual({
        deletedCount: 1,
      });
    } finally {
      delete adapter.findMany;
    }
    const rows = async (table: any) =>
      ((await table.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[]).map(
        (r) => r.id,
      );
    expect(moved).toBe(true);
    expect(await rows(t.owners)).toEqual([1, 3]);
    expect(await rows(t.items)).toEqual([1]);
  });
  it("bounded writes on a composite renamed key, NULL sort keys, a self-relation", async () => {
    const space = createTestSpace();
    await bootstrapStoredTables(space, [fx.BwBoard]);
    await checkBoundedComposite(space.getTable(fx.BwBoard));
  });
});
