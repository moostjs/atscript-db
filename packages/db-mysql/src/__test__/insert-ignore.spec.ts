import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

/**
 * Conflict-ignoring insert on MySQL (since 0.1.148): optimistic multi-row
 * INSERT per chunk (an all-new batch is ONE statement); on a duplicate key
 * (errno 1062 / 1586) one stored-key SELECT skips known duplicates and the
 * survivors go in as one INSERT; only a race bisects them (halves are retried,
 * recursively), a single row that still collides becoming a skipped slot.
 * Never `INSERT IGNORE`. Statement-shape tests over a recording driver (no
 * server needed).
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
  /** Every statement the table sent, whatever its kind (transaction control excluded). */
  const statements = () =>
    driver.calls.filter((c) => /^(INSERT|SELECT|UPDATE|DELETE|REPLACE)/i.test(c.sql));
  return { driver, table, inserts, selects, statements };
}

describe("MysqlAdapter insertManyIgnore", () => {
  it("all-new batch: ONE multi-row INSERT, no IGNORE / ON DUPLICATE KEY", async () => {
    const { table, inserts, statements } = setup(() => ({}));
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
    expect(statements()).toHaveLength(1);
    expect(inserts()[0]!.sql).not.toMatch(/IGNORE|ON DUPLICATE/i);
  });

  it("mixed batch: the duplicate chunk is bisected", async () => {
    const { table, inserts, statements } = setup((sql, params) => {
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
    // [a b c] fails, SELECT (finds nothing), [a] ok, [b c] fails, [b] fails, [c] ok
    expect(inserts()).toHaveLength(5);
    expect(statements()).toHaveLength(6);
  });

  it("a few duplicates among many rows: failed INSERT + SELECT + survivor INSERT", async () => {
    const stored = new Set(["s10", "s40"]);
    const { table, statements } = setup(
      (sql, params) => {
        if (sql.startsWith("INSERT") && params?.some((p) => stored.has(p as string))) throw dup();
        return {};
      },
      [
        { id: 11, sku: "s10" },
        { id: 41, sku: "s40" },
      ],
    );
    const rows = Array.from({ length: 64 }, (_, i) => item(i + 1, `s${i}`));
    const result = await table.insertMany(rows, { onConflict: "ignore" });
    expect(result.conflicts).toEqual([10, 40]);
    expect(result.insertedCount).toBe(62);
    expect(statements().map((c) => c.sql.split(" ")[0])).toEqual(["INSERT", "SELECT", "INSERT"]);
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
  it("dense duplicates: failed INSERT + SELECT + survivor INSERT per chunk, no bisect", async () => {
    // 3000 stored rows with odd ids interleaved in a 20000-row batch.
    const stored = Array.from({ length: 3000 }, (_, i) => ({ id: 2 * i + 1, sku: `old${i}` }));
    const chunkParams = Math.floor(60000 / 3) * 3;
    const { table, inserts, selects, statements } = setup((sql, params) => {
      // the full-chunk optimistic INSERT collides; the survivor INSERT is shorter
      if (sql.startsWith("INSERT") && params?.length === chunkParams) throw dup();
      return {};
    }, stored);
    const rows = Array.from({ length: 20000 }, (_, i) => item(i + 1, `s${i + 1}`));
    const result = await table.insertMany(rows, { onConflict: "ignore" });
    expect(result.conflicts).toHaveLength(3000);
    expect(result.conflicts.every((i: number) => (i + 1) % 2 === 1 && i < 6000)).toBe(true);
    expect(result.insertedCount).toBe(17000);
    expect(Math.ceil(20000 / Math.floor(60000 / 3))).toBe(1);
    expect(inserts()).toHaveLength(2);
    expect(selects()).toHaveLength(1);
    expect(statements()).toHaveLength(3);
  });

  it("no conflict: ONE INSERT and no SELECT", async () => {
    const { table, selects, statements } = setup(() => ({}));
    await table.insertMany([item(1, "a"), item(2, "b")], { onConflict: "ignore" });
    expect(selects()).toHaveLength(0);
    expect(statements()).toHaveLength(1);
  });

  it("the pre-check SELECT looks the chunk's keys up with IN lists", async () => {
    const { table, selects } = setup(
      (sql) => {
        if (sql.startsWith("INSERT")) throw dup();
        return {};
      },
      [{ id: 99, sku: "b" }],
    );
    await table.insertMany([item(1, "a"), item(2, "b")], { onConflict: "ignore" });
    expect(selects()).toHaveLength(1);
    expect(selects()[0]!.sql).toMatch(/^SELECT .* WHERE .*IN \(/);
  });

  it("stored unique-index key: the SELECT marks the row, the survivors go in one INSERT", async () => {
    const { table, inserts, selects } = setup(
      (sql, params) => {
        if (sql.startsWith("INSERT") && params?.includes("b")) throw dup();
        return {};
      },
      [{ id: 99, sku: "b" }],
    );
    const result = await table.insertMany([item(1, "a"), item(2, "b"), item(3, "c")], {
      onConflict: "ignore",
    });
    expect(result.conflicts).toEqual([1]);
    expect(result.insertedIds).toEqual([1, 3]);
    expect(selects()).toHaveLength(1);
    expect(inserts()).toHaveLength(2);
  });

  it("generated PK + unique-index conflict: ids of the survivors only", async () => {
    const driver = createMockDriver({
      runResponder: (sql, params) => {
        if (sql.startsWith("INSERT") && params?.includes("s1")) throw dup();
        return { insertId: 9 };
      },
      allResult: [{ id: 7, sku: "s1" }],
    });
    const table = new AtscriptDbTable(fx.IgAuto, new MysqlAdapter(driver)) as any;
    const result = await table.insertMany(
      [
        { sku: "s1", label: "dup" },
        { sku: "s2", label: "two" },
        { sku: "s3", label: "three" },
      ],
      { onConflict: "ignore" },
    );
    expect(result.conflicts).toEqual([0]);
    expect(result.inserted).toEqual([1, 2]);
    expect(result.insertedIds).toEqual([9, 10]);
    const kinds = driver.calls
      .filter((c) => /^(INSERT|SELECT)/.test(c.sql))
      .map((c) => c.sql.split(" ")[0]);
    expect(kinds).toEqual(["INSERT", "SELECT", "INSERT"]);
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

/** Generated-only statements report insertId 50; an explicit-only statement reports its last id. */
const mixedDriver = () =>
  createMockDriver({
    runResponder: (sql, params) =>
      sql.startsWith("INSERT") ? { insertId: params?.includes(100) ? 100 : 50 } : {},
  });

describe("MysqlAdapter mixed explicit and generated auto-increment PKs", () => {
  const rows = [
    { sku: "g1", label: "gen" },
    { id: 100, sku: "e1", label: "explicit" },
    { sku: "g2", label: "gen" },
  ];

  it("insertMany: explicit and generated rows are separate statements, ids in input order", async () => {
    const driver = mixedDriver();
    const table = new AtscriptDbTable(fx.IgAuto, new MysqlAdapter(driver)) as any;
    const result = await table.insertMany(rows);
    expect(result.insertedIds).toEqual([50, 100, 51]);
    const inserts = driver.calls.filter((c) => c.sql.startsWith("INSERT"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.params).toContain(100);
    expect(inserts[1]!.params).not.toContain(100);
  });

  it("insertMany ignore: same split, ids in input order, no SELECT for a clean batch", async () => {
    const driver = mixedDriver();
    const table = new AtscriptDbTable(fx.IgAuto, new MysqlAdapter(driver)) as any;
    const result = await table.insertMany(rows, { onConflict: "ignore" });
    expect(result.insertedIds).toEqual([50, 100, 51]);
    expect(result.inserted).toEqual([0, 1, 2]);
    expect(driver.calls.filter((c) => /^(INSERT|SELECT)/.test(c.sql))).toHaveLength(2);
    expect(driver.calls.some((c) => c.method === "all")).toBe(false);
  });

  it("a chunk of one kind stays ONE statement (generated ids are insertId + i)", async () => {
    const driver = mixedDriver();
    const table = new AtscriptDbTable(fx.IgAuto, new MysqlAdapter(driver)) as any;
    const result = await table.insertMany([rows[0], rows[2]]);
    expect(result.insertedIds).toEqual([50, 51]);
    expect(driver.calls.filter((c) => c.sql.startsWith("INSERT"))).toHaveLength(1);
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
