import { describe, it, expect, beforeAll } from "vite-plus/test";

import { DbError } from "../db-error";
import { DbSpace } from "../table/db-space";
import type { AtscriptDbTable } from "../table/db-table";
import type { TDbInsertIgnoreSlot, TDbInsertManyResult } from "../types";
import { MockAdapter, prepareFixtures } from "./test-utils";

/**
 * Conflict-ignoring insert (`onConflict: "ignore"`, since 0.1.148): the core
 * pre-dedups the batch, the adapter reports one slot per row, nested phases and
 * the post-write check only see inserted rows.
 */

/** Mock that supports ignore mode; rows whose `sku` is in `stored` collide. */
class IgnoreAdapter extends MockAdapter {
  stored = new Set<string>();
  ignoredBatches: Array<Array<Record<string, unknown>>> = [];
  plainBatches = 0;

  override supportsInsertIgnore(): boolean {
    return true;
  }

  override async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    this.plainBatches++;
    return super.insertMany(data);
  }

  override async insertManyIgnore(
    data: Array<Record<string, unknown>>,
  ): Promise<TDbInsertIgnoreSlot[]> {
    this.ignoredBatches.push(data);
    return data.map((row) => {
      const sku = row.sku as string | undefined;
      if (sku !== undefined && this.stored.has(sku)) return null;
      if (sku !== undefined) this.stored.add(sku);
      this._rows().push({ ...row });
      return { insertedId: row.id };
    });
  }
}

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/insert-ignore.as");
});

function setup(factory: () => MockAdapter = () => new IgnoreAdapter()) {
  const adapters = new Map<string, MockAdapter>();
  const space = new DbSpace(() => {
    const adapter = factory();
    return adapter;
  });
  const items = space.getTable(fx.IgItem) as AtscriptDbTable;
  const notes = space.getTable(fx.IgNote) as AtscriptDbTable;
  const orgs = space.getTable(fx.IgOrg) as AtscriptDbTable;
  void adapters;
  return {
    items,
    orgs,
    notes,
    itemsAdapter: items.dbAdapter as IgnoreAdapter,
    notesAdapter: notes.dbAdapter as MockAdapter,
  };
}

const row = (id: number, sku: string, extra: Record<string, unknown> = {}) => ({
  id,
  sku,
  qty: 1,
  ...extra,
});

describe("insertMany onConflict: ignore", () => {
  it("reports one slot per input row: inserted ids dense, positions and conflicts by index", async () => {
    const { items, itemsAdapter } = setup();
    itemsAdapter.stored.add("b");
    const result = await items.insertMany([row(1, "a"), row(2, "b"), row(3, "c")] as any, {
      onConflict: "ignore",
    });
    expect(result).toEqual({
      insertedCount: 2,
      insertedIds: [1, 3],
      inserted: [0, 2],
      conflicts: [1],
    });
    expect(itemsAdapter.plainBatches).toBe(0);
  });

  it("default mode is unchanged: no ignore path, plain result shape", async () => {
    const { items, itemsAdapter } = setup();
    const result = await items.insertMany([row(1, "a")] as any);
    expect(result).toEqual({ insertedCount: 1, insertedIds: [1] });
    expect(itemsAdapter.plainBatches).toBe(1);
    expect(itemsAdapter.ignoredBatches).toHaveLength(0);
    await items.insertMany([row(2, "b")] as any, { onConflict: "error" });
    expect(itemsAdapter.ignoredBatches).toHaveLength(0);
  });

  it("an unknown mode is INVALID_QUERY", async () => {
    const { items } = setup();
    await expect(
      items.insertMany([row(1, "a")] as any, { onConflict: "skip" } as any),
    ).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  it("pre-dedups the batch on the primary key: the earlier row wins, the adapter never sees the later", async () => {
    const { items, itemsAdapter } = setup();
    const result = await items.insertMany([row(1, "a"), row(1, "z"), row(2, "b")] as any, {
      onConflict: "ignore",
    });
    expect(result.conflicts).toEqual([1]);
    expect(result.inserted).toEqual([0, 2]);
    expect(itemsAdapter.ignoredBatches[0]!.map((r) => r.sku)).toEqual(["a", "b"]);
  });

  it("pre-dedups on a unique index and on a composite unique index", async () => {
    const { items, itemsAdapter } = setup();
    const result = await items.insertMany(
      [
        row(1, "a", { pairA: "x", pairB: "y" }),
        row(2, "a"),
        row(3, "c", { pairA: "x", pairB: "y" }),
        row(4, "d", { pairA: "x", pairB: "other" }),
      ] as any,
      { onConflict: "ignore" },
    );
    expect(result.conflicts).toEqual([1, 2]);
    expect(result.insertedIds).toEqual([1, 4]);
    expect(itemsAdapter.ignoredBatches[0]).toHaveLength(2);
  });

  it("pre-dedups on an adapter-contributed unique field that has no declared index", async () => {
    class DemotedAdapter extends IgnoreAdapter {
      override getMetadataOverrides() {
        return { addUniqueFields: ["code"] };
      }
    }
    const space = new DbSpace(() => new DemotedAdapter());
    const codes = space.getTable(fx.IgCode) as AtscriptDbTable;
    const result = await codes.insertMany(
      [
        { id: 1, code: "a" },
        { id: 2, code: "a" },
        { id: 3, code: "b" },
      ] as any,
      { onConflict: "ignore" },
    );
    expect(result.conflicts).toEqual([1]);
    expect(result.insertedIds).toEqual([1, 3]);
    expect((codes.dbAdapter as DemotedAdapter).ignoredBatches[0]).toHaveLength(2);
  });

  it("rows with a null or missing key component never collide with each other", async () => {
    const { items } = setup();
    const result = await items.insertMany(
      [
        row(1, "a", { pairA: "x" }),
        row(2, "b", { pairA: "x" }),
        row(3, "c", { pairA: "x", pairB: null }),
      ] as any,
      { onConflict: "ignore" },
    );
    expect(result.conflicts).toEqual([]);
    expect(result.insertedCount).toBe(3);
  });

  it("an all-conflict batch is a normal result", async () => {
    const { items, itemsAdapter } = setup();
    itemsAdapter.stored.add("a").add("b");
    const result = await items.insertMany([row(1, "a"), row(2, "b")] as any, {
      onConflict: "ignore",
    });
    expect(result).toEqual({ insertedCount: 0, insertedIds: [], inserted: [], conflicts: [0, 1] });
  });

  it("a TO object naming only the key links an existing parent (no parent is created)", async () => {
    const { items, orgs, itemsAdapter } = setup();
    await orgs.insertOne({ id: 9, name: "o" } as any);
    const result = await items.insertMany(
      [row(1, "a", { org: { id: 9 } }), row(2, "b", { orgId: 9 })] as any,
      { onConflict: "ignore" },
    );
    expect(result.conflicts).toEqual([]);
    expect(itemsAdapter.ignoredBatches[0]!.map((r) => [r.orgId, "org" in r])).toEqual([
      [9, false],
      [9, false],
    ]);
  });

  it("a key-only TO object that disagrees with the row's own foreign key is INVALID_QUERY", async () => {
    const { items, orgs, itemsAdapter } = setup();
    await orgs.insertOne({ id: 9, name: "o" } as any);
    const err = await items
      .insertMany([row(1, "a", { org: { id: 9 }, orgId: 8 })] as any, { onConflict: "ignore" })
      .catch((e) => e as DbError);
    expect((err as DbError).code).toBe("INVALID_QUERY");
    expect(itemsAdapter.ignoredBatches).toHaveLength(0);
  });

  it("a TO object with more than the key still creates a parent and is rejected", async () => {
    const { items } = setup();
    const err = await items
      .insertMany([row(1, "a", { org: { id: 9, name: "o" } })] as any, { onConflict: "ignore" })
      .catch((e) => e as DbError);
    expect((err as DbError).code).toBe("INVALID_QUERY");
    expect((err as DbError).errors[0]!.message).toMatch(/cannot create a related parent record/);
  });

  it("rejects a nested TO parent in ignore mode, before any write", async () => {
    const { items, itemsAdapter } = setup();
    const err = await items
      .insertMany([row(1, "a", { org: { id: 9, name: "o" } })] as any, { onConflict: "ignore" })
      .catch((e) => e as DbError);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("INVALID_QUERY");
    expect((err as DbError).errors[0]!.path).toBe("org");
    expect((err as DbError).errors[0]!.message).toMatch(/cannot create a related parent record/);
    expect(itemsAdapter.ignoredBatches).toHaveLength(0);
  });

  it("writes FROM children of inserted rows only", async () => {
    const { items, notesAdapter, itemsAdapter } = setup();
    itemsAdapter.stored.add("b");
    await items.insertMany(
      [
        row(1, "a", { notes: [{ id: 10, text: "n1" }] }),
        row(2, "b", { notes: [{ id: 20, text: "n2" }] }),
      ] as any,
      { onConflict: "ignore" },
    );
    const written = notesAdapter.calls
      .filter((c) => c.method === "insertMany")
      .flatMap((c) => c.args[0]) as Array<Record<string, unknown>>;
    expect(written.map((n) => n.id)).toEqual([10]);
    expect(written[0]!.itemId).toBe(1);
  });

  it("runs guard on ALL submitted rows, even ones that would conflict", async () => {
    const { items, itemsAdapter } = setup();
    itemsAdapter.stored.add("b");
    const seen: number[] = [];
    await items.insertMany([row(1, "a"), row(2, "b")] as any, {
      onConflict: "ignore",
      guard: (ctx) => {
        seen.push(ctx.rows.length);
      },
    });
    expect(seen).toEqual([2]);

    await expect(
      items.insertMany([row(1, "a"), row(2, "b")] as any, {
        onConflict: "ignore",
        guard: () => {
          throw new Error("forbidden");
        },
      }),
    ).rejects.toThrow("forbidden");
  });

  it("runs check once over the inserted rows only (and once, empty, when none inserted)", async () => {
    const { items, itemsAdapter } = setup();
    itemsAdapter.stored.add("b");
    const filters: unknown[][] = [];
    await items.insertMany([row(1, "a"), row(2, "b"), row(3, "c")] as any, {
      onConflict: "ignore",
      check: (ctx) => {
        filters.push([...ctx.filters]);
      },
    });
    expect(filters).toEqual([[{ id: 1 }, { id: 3 }]]);

    filters.length = 0;
    await items.insertMany([row(5, "b")] as any, {
      onConflict: "ignore",
      check: (ctx) => {
        filters.push([...ctx.filters]);
      },
    });
    expect(filters).toEqual([[]]);
  });

  it("validation errors still throw for the whole call", async () => {
    const { items, itemsAdapter } = setup();
    await expect(
      items.insertMany([row(1, "a"), { id: 2, qty: 1 }] as any, { onConflict: "ignore" }),
    ).rejects.toBeTruthy();
    expect(itemsAdapter.ignoredBatches).toHaveLength(0);
  });

  it("fails closed on an adapter without insertManyIgnore", async () => {
    const { items } = setup(() => new MockAdapter());
    const err = await items
      .insertMany([row(1, "a")] as any, { onConflict: "ignore" })
      .catch((e) => e as DbError);
    expect((err as DbError).code).toBe("ON_CONFLICT_NOT_SUPPORTED");
  });
});

describe("insertOne onConflict: ignore", () => {
  it("returns { insertedId, conflict: false } on insert and { conflict: true } on a skip", async () => {
    const { items, itemsAdapter } = setup();
    expect(await items.insertOne(row(1, "a") as any, { onConflict: "ignore" })).toEqual({
      insertedId: 1,
      conflict: false,
    });
    expect(await items.insertOne(row(2, "a") as any, { onConflict: "ignore" })).toEqual({
      conflict: true,
    });
    expect(itemsAdapter.plainBatches).toBe(0);
  });

  it("default insertOne keeps its shape", async () => {
    const { items } = setup();
    expect(await items.insertOne(row(1, "a") as any)).toEqual({ insertedId: 1 });
  });
});
