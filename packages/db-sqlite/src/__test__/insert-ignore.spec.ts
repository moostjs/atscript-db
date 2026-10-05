import { DbError, DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";

import { createAdapter } from "../index";
import { prepareFixtures } from "./test-utils";

/**
 * Conflict-ignoring insert on SQLite (since 0.1.148): per-row
 * `INSERT … ON CONFLICT DO NOTHING`; `changes === 0` marks a skipped row.
 * Also covers `DbSpace.close()` through the `createAdapter` helper.
 */

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
  space = createAdapter(":memory:");
  const result = await new SchemaSync(space).run([fx.IgItem, fx.IgAuto, fx.IgNote], {
    force: true,
  });
  expect(result.status).toBe("synced");
});

afterEach(async () => {
  await space.close();
});

describe("SQLite insertMany onConflict: ignore", () => {
  it("skips rows colliding with stored rows on the PK and on a secondary unique index", async () => {
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
    expect(result.insertedIds).toEqual([1]);
  });

  it("composite unique index, with NULL components never colliding", async () => {
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

  it("generated ids come back for inserted rows", async () => {
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
    expect(result.inserted).toEqual([1]);
    expect(result.insertedIds).toHaveLength(1);
    const stored = await auto.findOne({ filter: { sku: "s2" }, controls: {} });
    expect(result.insertedIds[0]).toBe(stored.id);
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

  it("an all-conflict batch inserts nothing", async () => {
    await items().insertMany([item(1, "a")]);
    const result = await items().insertMany([item(1, "a")], { onConflict: "ignore" });
    expect(result.insertedCount).toBe(0);
    expect(result.conflicts).toEqual([0]);
  });

  it("NOT NULL still raises (never INSERT OR IGNORE) and rolls the call back", async () => {
    const adapter = space.getAdapter(fx.IgItem);
    await expect(
      adapter.insertManyIgnore([
        { id: 1, sku: "a", qty: 1 },
        { id: 2, sku: "b" },
      ]),
    ).rejects.toThrow(/NOT NULL/);
    expect(await ids()).toEqual([]);
  });

  it("an FK violation still throws FK_VIOLATION and nothing is written", async () => {
    const notes = space.getTable(fx.IgNote) as any;
    const err = await notes
      .insertMany([{ id: 1, itemId: 99, text: "x" }], { onConflict: "ignore" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("FK_VIOLATION");
  });

  it("inside an outer transaction a skipped row never aborts it", async () => {
    await items().insertMany([item(1, "a")]);
    await items().dbAdapter.withTransaction(async () => {
      const result = await items().insertMany([item(2, "a"), item(3, "c")], {
        onConflict: "ignore",
      });
      expect(result.conflicts).toEqual([0]);
      await items().insertOne(item(4, "d"));
    });
    expect(await ids()).toEqual([1, 3, 4]);
  });

  it("the default mode still throws CONFLICT", async () => {
    await items().insertMany([item(1, "a")]);
    await expect(items().insertMany([item(2, "a")])).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("SQLite DbSpace.close() through createAdapter", () => {
  it("closes the driver: idempotent, and handles reject with SPACE_CLOSED", async () => {
    const own = createAdapter(":memory:");
    const table = own.getTable(fx.IgItem) as any;
    await table.ensureTable();
    await table.insertOne(item(1, "a"));
    await own.close();
    await own.close();
    await expect(table.findMany({ filter: {}, controls: {} })).rejects.toMatchObject({
      code: "SPACE_CLOSED",
    });
    expect(() => own.getTable(fx.IgItem)).toThrow(/closed/);
  });

  it("a driver closed separately does not break space.close()", async () => {
    const { BetterSqlite3Driver } = await import("../better-sqlite3-driver");
    const driver = new BetterSqlite3Driver(":memory:");
    driver.close();
    expect(() => driver.close()).not.toThrow();
  });
});
