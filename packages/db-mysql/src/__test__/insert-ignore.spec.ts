import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

/**
 * Conflict-ignoring insert on MySQL (since 0.1.148): optimistic multi-row
 * INSERT per chunk; a stored-key SELECT skips known duplicates and a race (errno 1062 / 1586)
 * bisects the survivors (halves are retried, recursively), a single row that still collides becoming a skipped slot. Never `INSERT IGNORE`. Statement-shape
 * tests over a recording driver (no server needed).
 */

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/insert-ignore.as");
});

const item = (id: number, sku: string) => ({ id, sku, qty: 1 });
const dup = (errno = 1062) =>
  Object.assign(new Error("Duplicate entry 'x' for key 'ig_items.sku_idx'"), { errno });

function setup(responder: (sql: string, params?: unknown[]) => unknown, allResult: unknown[] = []) {
  const driver = createMockDriver({ runResponder: responder as never, allResult });
  const table = new AtscriptDbTable(fx.IgItem, new MysqlAdapter(driver)) as any;
  const selects = () => driver.calls.filter((c) => c.method === "all");
  const inserts = () =>
    driver.calls.filter((c) => c.method === "run" && c.sql.startsWith("INSERT"));
  return { driver, table, inserts, selects };
}

describe("MysqlAdapter insertManyIgnore", () => {
  it("all-new batch: ONE multi-row INSERT, no IGNORE / ON DUPLICATE KEY", async () => {
    const { table, inserts } = setup(() => ({}));
    const result = await table.insertMany([item(1, "a"), item(2, "b"), item(3, "c")], {
      onConflict: "ignore",
    });
    expect(result).toEqual({
      insertedCount: 3,
      insertedIds: [1, 2, 3],
      inserted: [0, 1, 2],
      conflicts: [],
    });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]!.sql).not.toMatch(/IGNORE|ON DUPLICATE/i);
  });

  it("mixed batch: the duplicate chunk is bisected", async () => {
    const { table, inserts } = setup((sql, params) => {
      // Any statement carrying the stored row "b" fails (1586 once, then 1062).
      if (sql.startsWith("INSERT") && params?.includes("b"))
        throw dup(params.length > 3 ? 1062 : 1586);
      return {};
    });
    const result = await table.insertMany([item(1, "a"), item(2, "b"), item(3, "c")], {
      onConflict: "ignore",
    });
    expect(result).toEqual({
      insertedCount: 2,
      insertedIds: [1, 3],
      inserted: [0, 2],
      conflicts: [1],
    });
    // [a b c] fails, [a] ok, [b c] fails, [b] fails, [c] ok
    expect(inserts()).toHaveLength(5);
  });

  it("a few duplicates among many rows: fewer statements than rows", async () => {
    const stored = new Set(["s10", "s40"]);
    const { table, inserts } = setup((sql, params) => {
      if (sql.startsWith("INSERT") && params?.some((p) => stored.has(p as string))) throw dup();
      return {};
    });
    const rows = Array.from({ length: 64 }, (_, i) => item(i + 1, `s${i}`));
    const result = await table.insertMany(rows, { onConflict: "ignore" });
    expect(result.conflicts).toEqual([10, 40]);
    expect(result.insertedCount).toBe(62);
    expect(inserts().length).toBeLessThan(rows.length);
  });

  it("all-conflict batch", async () => {
    const { table } = setup(() => {
      throw dup();
    });
    const result = await table.insertMany([item(1, "a"), item(2, "b")], { onConflict: "ignore" });
    expect(result).toEqual({ insertedCount: 0, insertedIds: [], inserted: [], conflicts: [0, 1] });
  });

  it("a NOT NULL violation is NOT swallowed (proves IGNORE is not used)", async () => {
    const notNull = Object.assign(new Error("Column 'qty' cannot be null"), { errno: 1048 });
    const { table } = setup(() => {
      throw notNull;
    });
    await expect(
      table.insertMany([item(1, "a"), item(2, "b")], { onConflict: "ignore" }),
    ).rejects.toBe(notNull);
  });

  it("an FK violation on the replay path is still FK_VIOLATION", async () => {
    const fk = Object.assign(
      new Error("Cannot add or update a child row: FOREIGN KEY (`itemId`) REFERENCES"),
      { errno: 1452 },
    );
    const { table } = setup((sql) => {
      if ((sql.match(/\(\?/g) ?? []).length > 1) throw dup();
      throw fk;
    });
    await expect(
      table.insertMany([item(1, "a"), item(2, "b")], { onConflict: "ignore" }),
    ).rejects.toMatchObject({ code: "FK_VIOLATION" });
  });

  it("inside an outer transaction the replay does not roll anything back", async () => {
    const { table, driver } = setup((sql) => {
      if ((sql.match(/\(\?/g) ?? []).length > 1) throw dup();
      return {};
    });
    await table.dbAdapter.withTransaction(async () => {
      const result = await table.insertMany([item(1, "a"), item(2, "b")], { onConflict: "ignore" });
      expect(result.insertedCount).toBe(2);
    });
    expect(driver.calls.some((c) => c.method === "exec" && /ROLLBACK/i.test(c.sql))).toBe(false);
  });
});

describe("MysqlAdapter insertManyIgnore pre-check", () => {
  it("dense duplicates: one SELECT + one INSERT per chunk, no bisect", async () => {
    // 3000 stored rows with odd ids interleaved in a 20000-row batch.
    const stored = Array.from({ length: 3000 }, (_, i) => ({ id: 2 * i + 1, sku: `old${i}` }));
    const { table, inserts, selects } = setup(() => ({}), stored);
    const rows = Array.from({ length: 20000 }, (_, i) => item(i + 1, `s${i + 1}`));
    const result = await table.insertMany(rows, { onConflict: "ignore" });
    expect(result.conflicts).toHaveLength(3000);
    expect(result.conflicts.every((i: number) => (i + 1) % 2 === 1 && i < 6000)).toBe(true);
    expect(result.insertedCount).toBe(17000);
    const chunks = Math.ceil(20000 / Math.floor(60000 / 3));
    expect(inserts()).toHaveLength(chunks);
    expect(inserts().length + selects().length).toBeLessThanOrEqual(chunks * 2 + 2);
  });

  it("no conflict: one SELECT and one INSERT per chunk", async () => {
    const { table, inserts, selects } = setup(() => ({}));
    await table.insertMany([item(1, "a"), item(2, "b")], { onConflict: "ignore" });
    expect(selects()).toHaveLength(1);
    expect(selects()[0]!.sql).toMatch(/^SELECT .* WHERE .*IN \(/);
    expect(inserts()).toHaveLength(1);
  });

  it("stored unique-index key marks the row without any failed INSERT", async () => {
    const { table, inserts } = setup(() => ({}), [{ id: 99, sku: "b" }]);
    const result = await table.insertMany([item(1, "a"), item(2, "b"), item(3, "c")], {
      onConflict: "ignore",
    });
    expect(result.conflicts).toEqual([1]);
    expect(result.insertedIds).toEqual([1, 3]);
    expect(inserts()).toHaveLength(1);
  });

  it("generated PK and no unique values: no SELECT at all", async () => {
    const { table, selects } = setup(() => ({}));
    await table.dbAdapter.insertManyIgnore([{ label: "x" }]);
    expect(selects()).toHaveLength(0);
  });

  it("a race after the pre-check falls back to bisecting the survivors", async () => {
    // Pre-check sees nothing stored; "b" appears concurrently.
    const { table, inserts, selects } = setup((sql, params) => {
      if (sql.startsWith("INSERT") && params?.includes("b")) throw dup();
      return {};
    });
    const result = await table.insertMany([item(1, "a"), item(2, "b"), item(3, "c")], {
      onConflict: "ignore",
    });
    expect(selects()).toHaveLength(1);
    expect(result.conflicts).toEqual([1]);
    expect(result.inserted).toEqual([0, 2]);
    expect(inserts().length).toBeGreaterThan(1);
  });
});

describe("Mysql2Driver.close()", () => {
  it("is idempotent: a second close never ends the pool twice", async () => {
    const { Mysql2Driver } = await import("../mysql2-driver");
    const driver = new Mysql2Driver("mysql://u@127.0.0.1:1/none");
    await driver.close();
    await expect(driver.close()).resolves.toBeUndefined();
  });
});
