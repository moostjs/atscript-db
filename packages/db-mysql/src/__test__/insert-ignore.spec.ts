import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { AtscriptDbTable, DbSpace } from "@atscript/db";

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
      .filter((c) => /^(INSERT|SELECT)/.test(c.sql) && !c.sql.startsWith("SELECT @@"))
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
const mixedDriver = (step?: number) =>
  createMockDriver({
    runResponder: (sql, params) =>
      sql.startsWith("INSERT") ? { insertId: params?.includes(100) ? 100 : 50 } : {},
    get: [["@@auto_increment_increment", { step }]],
  });

describe("MysqlAdapter mixed explicit and generated auto-increment PKs", () => {
  const rows = [
    { sku: "g1", label: "gen" },
    { id: 100, sku: "e1", label: "explicit" },
    { sku: "g2", label: "gen" },
  ];

  it("insertMany: consecutive runs of one kind are separate statements, executed in input order", async () => {
    const driver = mixedDriver();
    const table = new AtscriptDbTable(fx.IgAuto, new MysqlAdapter(driver)) as any;
    const result = await table.insertMany(rows);
    expect(result.insertedIds).toEqual([50, 100, 50]);
    const inserts = driver.calls.filter((c) => c.sql.startsWith("INSERT"));
    expect(inserts).toHaveLength(3);
    expect(inserts.map((c) => c.params?.includes(100))).toEqual([false, true, false]);
    // single-row runs need no stride: no @@auto_increment_increment read
    expect(driver.calls.some((c) => c.sql.includes("@@"))).toBe(false);
  });

  it("an explicit row between two generated ones does not move before the earlier row (earlier row wins under _ci)", async () => {
    const driver = mixedDriver();
    const table = new AtscriptDbTable(fx.IgAuto, new MysqlAdapter(driver)) as any;
    // g1 (generated) and e1 (explicit) differ only by case in their unique value
    await table.insertMany([
      { sku: "Dup", label: "earlier, generated" },
      { id: 100, sku: "dup", label: "later, explicit" },
    ]);
    const inserts = driver.calls.filter((c) => c.sql.startsWith("INSERT"));
    expect(inserts[0]!.params).toContain("Dup");
    expect(inserts[1]!.params).toContain("dup");
  });

  it("the increment step is read on the SAME connection as the INSERT it maps ids for", async () => {
    const driver = mixedDriver(3);
    const table = new AtscriptDbTable(fx.IgAuto, new MysqlAdapter(driver)) as any;
    await table.insertMany([rows[0], rows[2]]);
    await table.insertMany([rows[0], rows[2]], { onConflict: "ignore" });
    const step = driver.calls.filter((c) => c.sql.startsWith("SELECT @@"));
    const inserts = driver.calls.filter((c) => c.sql.startsWith("INSERT"));
    expect(step.length).toBeGreaterThan(0);
    expect([...step, ...inserts].every((c) => c.via === "conn")).toBe(true);
  });

  it("insertMany ignore: same runs, ids in input order, no SELECT for a clean batch", async () => {
    const driver = mixedDriver();
    const table = new AtscriptDbTable(fx.IgAuto, new MysqlAdapter(driver)) as any;
    const result = await table.insertMany(rows, { onConflict: "ignore" });
    expect(result.insertedIds).toEqual([50, 100, 50]);
    expect(result.inserted).toEqual([0, 1, 2]);
    expect(driver.calls.filter((c) => /^(INSERT|SELECT)/.test(c.sql))).toHaveLength(3);
    expect(driver.calls.some((c) => c.method === "all")).toBe(false);
  });

  it("a chunk of one kind stays ONE statement (generated ids are insertId + i * @@auto_increment_increment)", async () => {
    const driver = mixedDriver(3);
    const table = new AtscriptDbTable(fx.IgAuto, new MysqlAdapter(driver)) as any;
    const result = await table.insertMany([rows[0], rows[2], { sku: "g3", label: "gen" }]);
    expect(result.insertedIds).toEqual([50, 53, 56]);
    expect(driver.calls.filter((c) => c.sql.startsWith("INSERT"))).toHaveLength(1);
    // the stride is read once for the call
    expect(driver.calls.filter((c) => c.sql.startsWith("SELECT @@"))).toHaveLength(1);
    const ignored = await table.insertMany([rows[0], rows[2]], { onConflict: "ignore" });
    expect(ignored.insertedIds).toEqual([50, 53]);
  });

  it("an increment of 1 (or an unreadable one) is the plain consecutive sequence", async () => {
    for (const step of [1, undefined]) {
      const table = new AtscriptDbTable(fx.IgAuto, new MysqlAdapter(mixedDriver(step))) as any;
      const result = await table.insertMany([rows[0], rows[2]]);
      expect(result.insertedIds).toEqual([50, 51]);
    }
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

describe("renamed @db.default.increment primary key", () => {
  it("DDL keeps AUTO_INCREMENT on the renamed column", async () => {
    const driver = createMockDriver();
    const table = new AtscriptDbTable(fx.IgRenamed, new MysqlAdapter(driver)) as any;
    await table.ensureTable();
    const create = driver.calls.find((c) => c.sql.startsWith("CREATE TABLE"))!.sql;
    expect(create).toMatch(/`item_id` \w+ NOT NULL AUTO_INCREMENT|`item_id` [^,]*AUTO_INCREMENT/);
  });
});

const pk = () =>
  Object.assign(new Error("Duplicate entry '5' for key 'ig_auto.PRIMARY'"), { errno: 1062 });
const modeReads = (driver: ReturnType<typeof createMockDriver>) =>
  driver.calls.filter((c) => c.sql.includes("@@SESSION.sql_mode"));

describe("generated ids, NO_AUTO_VALUE_ON_ZERO and strict mode", () => {
  const auto = (
    responder: (sql: string) => unknown,
    get: Array<[string, unknown]> = [],
    logger?: object,
  ) => {
    const driver = createMockDriver({ runResponder: responder as never, get });
    const space = new DbSpace(
      () => new MysqlAdapter(driver),
      logger ? { logger: logger as never } : undefined,
    );
    return { driver, table: space.getTable(fx.IgAuto) as any };
  };

  it("a PRIMARY duplicate of a GENERATED id is rethrown, never skipped", async () => {
    const { table } = auto((sql) => {
      if (sql.startsWith("INSERT")) throw pk();
      return undefined;
    });
    await expect(
      table.insertMany([{ sku: "a", label: "x" }], { onConflict: "ignore" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      table.insertMany(
        [
          { sku: "a", label: "x" },
          { sku: "b", label: "y" },
        ],
        { onConflict: "ignore" },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a PRIMARY duplicate of a generated id on a hyphenated / non-ASCII table is rethrown too", async () => {
    for (const table of ["order-items", "tbl_ü"]) {
      const dup = Object.assign(new Error(`Duplicate entry '5' for key '${table}.PRIMARY'`), {
        errno: 1062,
      });
      const { table: t } = auto((sql) => {
        if (sql.startsWith("INSERT")) throw dup;
        return undefined;
      });
      await expect(
        t.insertMany([{ sku: "a", label: "x" }], { onConflict: "ignore" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }
  });

  it("a unique-index duplicate of a generated-id row is still an ignorable conflict", async () => {
    const { table } = auto((sql) => {
      if (sql.startsWith("INSERT"))
        throw Object.assign(new Error("Duplicate entry 'a' for key 'ig_auto.auto_sku_idx'"), {
          errno: 1062,
        });
      return undefined;
    });
    const result = await table.insertMany([{ sku: "a", label: "x" }], { onConflict: "ignore" });
    expect(result.conflicts).toEqual([0]);
  });

  it("an explicit PRIMARY duplicate stays an ignorable conflict", async () => {
    const { table } = auto((sql) => {
      if (sql.startsWith("INSERT")) throw pk();
      return undefined;
    });
    const result = await table.insertMany([{ id: 5, sku: "a", label: "x" }], {
      onConflict: "ignore",
    });
    expect(result.conflicts).toEqual([0]);
  });

  it("NO_AUTO_VALUE_ON_ZERO: an explicit 0 PK is a value (one sql_mode read per call)", async () => {
    const { driver, table } = auto(
      () => ({ insertId: 99 }),
      [["sql_mode", { mode: "STRICT_TRANS_TABLES,NO_AUTO_VALUE_ON_ZERO" }]],
    );
    const result = await table.insertMany(
      [
        { id: 0, sku: "a", label: "x" },
        { id: 7, sku: "b", label: "y" },
      ],
      { onConflict: "ignore" },
    );
    expect(result.insertedIds).toEqual([0, 7]);
    expect(modeReads(driver)).toHaveLength(1);
    const plain = await table.insertMany([{ id: 0, sku: "c", label: "z" }]);
    expect(plain.insertedIds).toEqual([0]);
  });

  it("without NO_AUTO_VALUE_ON_ZERO an explicit 0 is generated (and rows without a 0 read no sql_mode)", async () => {
    const { driver, table } = auto(
      () => ({ insertId: 99 }),
      [["sql_mode", { mode: "STRICT_TRANS_TABLES" }]],
    );
    const result = await table.insertMany([{ id: 0, sku: "a", label: "x" }], {
      onConflict: "ignore",
    });
    expect(result.insertedIds).toEqual([99]);
    await table.insertMany([{ sku: "b", label: "y" }]);
    expect(modeReads(driver)).toHaveLength(1);
  });

  it("warns ONCE per driver when the session sql_mode is not strict", async () => {
    const warn = vi.fn();
    const logger = { error() {}, warn, log() {}, info() {}, debug() {} };
    const { table } = auto(() => ({}), [["sql_mode", { mode: "NO_ENGINE_SUBSTITUTION" }]], logger);
    await table.insertMany([{ sku: "a", label: "x" }], { onConflict: "ignore" });
    await table.insertMany([{ sku: "b", label: "x" }], { onConflict: "ignore" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("STRICT_TRANS_TABLES");
  });

  it("stays silent on a strict mode, and without a logger probes nothing", async () => {
    const warn = vi.fn();
    const strict = auto(() => ({}), [["sql_mode", { mode: "STRICT_TRANS_TABLES" }]], {
      error() {},
      warn,
      log() {},
      info() {},
      debug() {},
    });
    await strict.table.insertMany([{ sku: "a", label: "x" }], { onConflict: "ignore" });
    expect(warn).not.toHaveBeenCalled();
    const quiet = auto(() => ({}), [["sql_mode", { mode: "" }]]);
    await quiet.table.insertMany([{ sku: "a", label: "x" }], { onConflict: "ignore" });
    expect(modeReads(quiet.driver)).toHaveLength(0);
  });
});
