import type { DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

/** Conflict-ignoring insert and `DbSpace.close()` on the memory adapter (since 0.1.148). */

let fx: Record<string, any>;
let space: DbSpace;

const item = (id: number, sku: string, extra: Record<string, unknown> = {}) => ({
  id,
  sku,
  qty: 1,
  ...extra,
});
const items = () => space.getTable(fx.IgItem) as any;
const ids = async () =>
  ((await items().findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[]).map(
    (r) => r.id,
  );

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/insert-ignore.as");
});

beforeEach(async () => {
  space = createTestSpace();
  await bootstrapStoredTables(space, [fx.IgItem, fx.IgAuto, fx.IgNote]);
});

describe("MemoryAdapter insertMany onConflict: ignore", () => {
  it("skips rows colliding with stored rows on the PK and on a unique index", async () => {
    await items().insertMany([item(1, "a"), item(2, "b")]);
    const result = await items().insertMany([item(1, "zz"), item(3, "b"), item(4, "d")], {
      onConflict: "ignore",
    });
    expect(result).toEqual({
      insertedCount: 1,
      insertedIds: [4],
      inserted: [2],
      conflicts: [0, 1],
    });
    expect(await ids()).toEqual([1, 2, 4]);
  });

  it("intra-batch duplicates: the first row wins", async () => {
    const result = await items().insertMany([item(1, "a"), item(2, "a"), item(1, "x")], {
      onConflict: "ignore",
    });
    expect(result.conflicts).toEqual([1, 2]);
    expect(await ids()).toEqual([1]);
  });

  it("composite unique index; NULL components never collide", async () => {
    await items().insertMany([item(1, "a", { pairA: "x", pairB: "y" })]);
    const result = await items().insertMany(
      [
        item(2, "b", { pairA: "x", pairB: "y" }),
        item(3, "c", { pairA: "x" }),
        item(4, "d", { pairA: "x" }),
      ],
      { onConflict: "ignore" },
    );
    expect(result.conflicts).toEqual([0]);
    expect(result.insertedIds).toEqual([3, 4]);
  });

  it("generated (increment) ids come back for inserted rows only", async () => {
    const auto = space.getTable(fx.IgAuto) as any;
    await auto.insertOne({ sku: "s1", label: "one" });
    const result = await auto.insertMany(
      [
        { sku: "s1", label: "dup" },
        { sku: "s2", label: "two" },
      ],
      { onConflict: "ignore" },
    );
    expect(result.conflicts).toEqual([0]);
    const stored = await auto.findOne({ filter: { sku: "s2" }, controls: {} });
    expect(result.insertedIds).toEqual([stored.id]);
  });

  it("insertOne: { insertedId, conflict } / { conflict: true }", async () => {
    expect(await items().insertOne(item(1, "a"), { onConflict: "ignore" })).toEqual({
      insertedId: 1,
      conflict: false,
    });
    expect(await items().insertOne(item(2, "a"), { onConflict: "ignore" })).toEqual({
      conflict: true,
    });
  });

  it("an FK violation still throws", async () => {
    const notes = space.getTable(fx.IgNote) as any;
    await expect(
      notes.insertMany([{ id: 1, itemId: 99, text: "x" }], { onConflict: "ignore" }),
    ).rejects.toMatchObject({ code: "FK_VIOLATION" });
  });

  it("the default mode still throws CONFLICT", async () => {
    await items().insertMany([item(1, "a")]);
    await expect(items().insertMany([item(2, "a")])).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("MemoryAdapter DbSpace.close()", () => {
  it("drops the space's state; handles reject with SPACE_CLOSED", async () => {
    const table = items();
    await table.insertMany([item(1, "a")]);
    await space.close();
    await space.close();
    await expect(table.findMany({ filter: {}, controls: {} })).rejects.toMatchObject({
      code: "SPACE_CLOSED",
    });
  });
});

describe("MemoryAdapter state lifecycle", () => {
  it("the table state is cleared by the space (onClose), never by an adapter's dispose", async () => {
    const other = createTestSpace();
    await bootstrapStoredTables(other, [fx.IgItem]);
    await (other.getTable(fx.IgItem) as any).insertMany([item(1, "a")]);
    await items().insertMany([item(1, "a")]);
    expect((items().dbAdapter as { dispose?: unknown }).dispose).toBeUndefined();
    await space.close();
    // closing one space leaves another space's database untouched
    expect(await (other.getTable(fx.IgItem) as any).count({ filter: {}, controls: {} })).toBe(1);
  });
});

describe("MemoryAdapter empty membership through the table", () => {
  it("$in: [] returns no rows; $nin: [] returns all rows incl. null / missing", async () => {
    await items().insertMany([
      item(1, "a", { pairA: "x" }),
      item(2, "b"),
      item(3, "c", { pairA: null }),
    ]);
    const idsOf = async (filter: Record<string, unknown>) =>
      ((await items().findMany({ filter, controls: { $sort: { id: 1 } } })) as any[]).map(
        (r) => r.id,
      );
    expect(await idsOf({ pairA: { $in: [] } })).toEqual([]);
    expect(await idsOf({ pairA: { $nin: [] } })).toEqual([1, 2, 3]);
  });
});
