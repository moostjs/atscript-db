import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { mapIgnoredBatch } from "../insert-ignore";
import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

/**
 * Batched conflict-ignoring insert on PostgreSQL (since 0.1.148): one
 * `INSERT … ON CONFLICT DO NOTHING RETURNING <pk + unique key columns>` per
 * chunk; skipped rows are the ones missing from RETURNING, mapped back by key.
 * Statement-shape tests over a recording driver (no server needed).
 */

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/insert-ignore.as");
});

const item = (id: number, sku: string, extra: Record<string, unknown> = {}) => ({
  id,
  sku,
  qty: 1,
  ...extra,
});

/** A table over a driver whose INSERT … RETURNING answers `returned(sql, params)`. */
function setup(returned: (params: unknown[]) => Array<Record<string, unknown>>) {
  const driver = createMockDriver({
    runResponder: (sql, params) =>
      sql.startsWith("INSERT") ? { rows: returned(params ?? []) } : {},
  });
  const table = new AtscriptDbTable(fx.IgItem, new PostgresAdapter(driver)) as any;
  const inserts = () =>
    driver.calls.filter((c) => c.method === "run" && c.sql.startsWith("INSERT"));
  return { driver, table, inserts };
}

describe("PostgresAdapter insertManyIgnore", () => {
  it("all-new batch: ONE statement, ids from RETURNING", async () => {
    const { table, inserts } = setup(() => [
      { id: 1, sku: "a", pairA: null, pairB: null },
      { id: 2, sku: "b", pairA: null, pairB: null },
      { id: 3, sku: "c", pairA: null, pairB: null },
    ]);
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
    const sql = inserts()[0]!.sql;
    expect(sql).toMatch(/ON CONFLICT DO NOTHING RETURNING "id", "sku", "pairA", "pairB"$/);
    expect((sql.match(/\(\$/g) ?? []).length).toBe(3);
  });

  it("mixed batch: rows missing from RETURNING are the conflicts", async () => {
    const { table, inserts } = setup(() => [
      { id: 1, sku: "a", pairA: null, pairB: null },
      { id: 3, sku: "c", pairA: null, pairB: null },
    ]);
    const result = await table.insertMany([item(1, "a"), item(2, "b"), item(3, "c")], {
      onConflict: "ignore",
    });
    expect(result).toEqual({
      insertedCount: 2,
      insertedIds: [1, 3],
      inserted: [0, 2],
      conflicts: [1],
    });
    expect(inserts()).toHaveLength(1);
  });

  it("all-conflict batch: RETURNING is empty", async () => {
    const { table } = setup(() => []);
    const result = await table.insertMany([item(1, "a"), item(2, "b")], { onConflict: "ignore" });
    expect(result).toEqual({ insertedCount: 0, insertedIds: [], inserted: [], conflicts: [0, 1] });
  });

  it("generated PK + unique-index conflict: rows are matched on the unique key", async () => {
    const driver = createMockDriver({
      runResponder: (sql) => (sql.startsWith("INSERT") ? { rows: [{ id: 41, sku: "s2" }] } : {}),
    });
    const auto = new AtscriptDbTable(fx.IgAuto, new PostgresAdapter(driver)) as any;
    const result = await auto.insertMany(
      [
        { sku: "s1", label: "dup" },
        { sku: "s2", label: "new" },
      ],
      { onConflict: "ignore" },
    );
    expect(result).toEqual({ insertedCount: 1, insertedIds: [41], inserted: [1], conflicts: [0] });
    const sql = driver.calls.find((c) => c.method === "run" && c.sql.startsWith("INSERT"))!.sql;
    expect(sql).toContain('RETURNING "id", "sku"');
  });

  it("ambiguous RETURNING: ROLLBACK TO SAVEPOINT, then the chunk is redone row by row", async () => {
    const driver = createMockDriver({
      runResponder: (sql, params) => {
        if (!sql.startsWith("INSERT")) return {};
        if ((sql.match(/\(\$/g) ?? []).length > 1) {
          // two rows back for three sent, neither matching a sent key
          return {
            rows: [
              { id: 91, sku: "x" },
              { id: 92, sku: "y" },
            ],
          };
        }
        return params?.[0] === 2 ? { rows: [] } : { rows: [{ id: params?.[0], sku: params?.[1] }] };
      },
    });
    const table = new AtscriptDbTable(fx.IgItem, new PostgresAdapter(driver)) as any;
    const result = await table.insertMany([item(1, "a"), item(2, "b"), item(3, "c")], {
      onConflict: "ignore",
    });
    expect(result).toEqual({
      insertedCount: 2,
      insertedIds: [1, 3],
      inserted: [0, 2],
      conflicts: [1],
    });
    const sqls = driver.calls.filter((c) => c.method === "run").map((c) => c.sql);
    const iSave = sqls.findIndex((q) => q.startsWith("SAVEPOINT"));
    const iBack = sqls.findIndex((q) => q.startsWith("ROLLBACK TO SAVEPOINT"));
    expect(iSave).toBeGreaterThanOrEqual(0);
    expect(iBack).toBeGreaterThan(iSave);
    expect(sqls.filter((q) => q.startsWith("INSERT"))).toHaveLength(4);
    expect(sqls.slice(iBack + 1).every((q) => /ON CONFLICT DO NOTHING/.test(q))).toBe(true);
  });

  it("inside an outer transaction the same statements run on the transaction's connection", async () => {
    const { table, inserts, driver } = setup(() => [{ id: 2, sku: "b", pairA: null, pairB: null }]);
    await table.dbAdapter.withTransaction(async () => {
      const result = await table.insertMany([item(1, "a"), item(2, "b")], { onConflict: "ignore" });
      expect(result.conflicts).toEqual([0]);
      await table.insertOne(item(9, "z"));
    });
    expect(inserts()).toHaveLength(2);
    expect(driver.calls.some((c) => c.method === "exec" && /ROLLBACK/i.test(c.sql))).toBe(false);
  });

  it("chunks by the parameter limit: one statement per chunk", async () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => item(i + 1, `s${i}`));
    const { table, inserts } = setup((params) =>
      // every row of the chunk is inserted: 5 columns (id, sku, qty + optional absent) per row
      Array.from({ length: params.length / 3 }, (_, i) => ({
        id: params[i * 3],
        sku: params[i * 3 + 1],
        pairA: null,
        pairB: null,
      })),
    );
    const result = await table.insertMany(rows, { onConflict: "ignore" });
    expect(result.insertedCount).toBe(30_000);
    expect(inserts().length).toBeGreaterThan(1);
  });
});

describe("PostgresAdapter insertManyIgnore lockConflicts (since 0.1.153)", () => {
  function lockSetup(stored: Array<Record<string, unknown>>, raced: string[] = []) {
    const driver = createMockDriver({
      runResponder: (sql, params) =>
        sql.startsWith("INSERT")
          ? {
              rows: [
                { id: 5, sku: "e", pairA: null, pairB: null },
                ...(params?.includes("z") && !raced.includes("z")
                  ? [{ id: 8, sku: "z", pairA: null, pairB: null }]
                  : []),
              ],
            }
          : {},
      allResult: (sql) => (/FOR UPDATE/.test(sql) ? stored : []),
    });
    const table = new AtscriptDbTable(fx.IgItem, new PostgresAdapter(driver)) as any;
    const sent = () =>
      driver.calls.filter((c) => /^(INSERT|SELECT|UPDATE)/.test(c.sql)).map((c) => c);
    return { driver, table, sent };
  }

  it("locks the stored conflicting rows FOR UPDATE in primary-key order BEFORE the insert", async () => {
    const { table, sent } = lockSetup([{ id: 2, sku: "b", pairA: null, pairB: null }]);
    const result = await table.dbAdapter.withTransaction(() =>
      table.insertMany([item(2, "b"), item(5, "e")], {
        onConflict: "ignore",
        lockConflicts: true,
      }),
    );
    expect(result.conflicts).toEqual([0]);
    expect(result.insertedIds).toEqual([5]);
    const calls = sent();
    expect(calls.map((c) => c.sql.split(" ")[0])).toEqual(["SELECT", "INSERT"]);
    expect(calls[0]!.sql).toBe(
      'SELECT "id", "sku", "pairA", "pairB" FROM "ig_items" WHERE ("id") IN (($1), ($2)) OR ("sku") IN (($3), ($4)) ORDER BY "id" FOR UPDATE',
    );
    expect(calls[0]!.params).toEqual([2, 5, "b", "e"]);
  });

  it("a row a concurrent writer committed after the lock is locked after the insert", async () => {
    const { table, sent } = lockSetup([], ["z"]);
    const result = await table.dbAdapter.withTransaction(() =>
      table.insertMany([item(5, "e"), item(8, "z")], {
        onConflict: "ignore",
        lockConflicts: true,
      }),
    );
    expect(result.conflicts).toEqual([1]);
    const calls = sent();
    expect(calls.map((c) => c.sql.split(" ")[0])).toEqual(["SELECT", "INSERT", "SELECT"]);
    expect(calls[2]!.params).toEqual([8, "z"]);
  });

  it("is a no-op outside a caller transaction", async () => {
    const { table, sent } = lockSetup([]);
    await table.insertMany([item(5, "e")], { onConflict: "ignore", lockConflicts: true });
    expect(sent().map((c) => c.sql.split(" ")[0])).toEqual(["INSERT"]);
  });
});

describe("PostgresAdapter lock-contention errors (since 0.1.153)", () => {
  it.each([
    ["40P01", "DEADLOCK"],
    ["55P03", "LOCK_TIMEOUT"],
    ["40001", "SERIALIZATION_FAILURE"],
  ])("SQLSTATE %s → retryable DbError %s", async (code, expected) => {
    const driver = createMockDriver({
      runResponder: () => {
        throw Object.assign(new Error("lock"), { code });
      },
    });
    const table = new AtscriptDbTable(fx.IgItem, new PostgresAdapter(driver)) as any;
    const error = await table.updateOne({ id: 1, qty: 2 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: expected, retryable: true });
  });
});

describe("mapIgnoredBatch", () => {
  const keys = [["id"], ["sku"], ["a", "b"]];

  it("maps by key values in order", () => {
    const batch = [
      { id: 1, sku: "x" },
      { id: 2, sku: "y" },
      { id: 3, sku: "z" },
    ];
    const returned = [
      { id: 1, sku: "x" },
      { id: 3, sku: "z" },
    ];
    expect(mapIgnoredBatch(batch, returned, keys)).toEqual([0, -1, 1]);
  });

  it("generated PK: matches on the unique column only", () => {
    const batch = [{ sku: "x" }, { sku: "y" }];
    expect(mapIgnoredBatch(batch, [{ id: 7, sku: "y" }], keys)).toEqual([-1, 0]);
  });

  it("keyless rows are ambiguous (a colliding sequence value must not be trusted)", () => {
    expect(
      mapIgnoredBatch([{ label: "a" }, { label: "b" }], [{ id: 11 }], [["id"]]),
    ).toBeUndefined();
  });

  it("every fully-defined key set must match: an explicit id equal to the next sequence value", () => {
    const batch = [{ id: 8, sku: "x" }, { sku: "y" }];
    expect(mapIgnoredBatch(batch, [{ id: 8, sku: "y" }], [["id"], ["sku"]])).toEqual([-1, 0]);
  });

  it("a string key of a non-text column (uuid without hyphens, inet) is ambiguous when it looks skipped", () => {
    const batch = [
      { id: "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa" },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    ];
    const returned = [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }];
    expect(mapIgnoredBatch(batch, returned, [["id"]], new Set(["id"]))).toBeUndefined();
    // a text column keeps the exact skip mapping
    expect(mapIgnoredBatch(batch, returned, [["id"]], new Set())).toEqual([-1, 0]);
  });

  it("lossy normalisation (NUMERIC(10,0)) is ambiguous, not mis-mapped", () => {
    expect(mapIgnoredBatch([{ v: 1.4 }, { v: 1 }], [{ v: "1" }], [["v"]])).toBeUndefined();
  });

  it("the same key written differently (NUMERIC 5 / '5.00', CHAR padding) is ambiguous", () => {
    expect(mapIgnoredBatch([{ v: 5 }, { v: 7 }], [{ v: "5.00" }], [["v"]])).toBeUndefined();
    expect(mapIgnoredBatch([{ c: "ab" }, { c: "cd" }], [{ c: "ab   " }], [["c"]])).toBeUndefined();
    // the same value written twice: only the first is inserted — never reported as the second
    expect(mapIgnoredBatch([{ v: 5 }, { v: "5.00" }], [{ v: "5.00" }], [["v"]])).toBeUndefined();
    expect(
      mapIgnoredBatch([{ c: "ab" }, { c: "ab   " }], [{ c: "ab   " }], [["c"]]),
    ).toBeUndefined();
    // a returned key that equals no input at all stays a plain skip of the others
    expect(mapIgnoredBatch([{ v: 5 }, { v: 7 }], [{ v: 7 }], [["v"]])).toEqual([-1, 0]);
  });

  it("keys differing only in letter case (uuid output is lower-cased) are ambiguous, never swapped", () => {
    // [AAA, aaa] on a uuid key: the first is inserted (returned as "aaa"), the second skipped
    expect(mapIgnoredBatch([{ u: "AAA" }, { u: "aaa" }], [{ u: "aaa" }], [["u"]])).toBeUndefined();
    // the written-lower-case row is the returned one: exact
    expect(mapIgnoredBatch([{ u: "aaa" }, { u: "AAA" }], [{ u: "aaa" }], [["u"]])).toEqual([0, -1]);
    // unrelated keys still map exactly
    expect(mapIgnoredBatch([{ u: "AAA" }, { u: "bbb" }], [{ u: "bbb" }], [["u"]])).toEqual([-1, 0]);
  });

  it("compares across Date / bigint / number representations", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    expect(mapIgnoredBatch([{ id: 1n }, { id: 2n }], [{ id: 2 }], [["id"]])).toEqual([-1, 0]);
    expect(
      mapIgnoredBatch(
        [{ t: d.toISOString() }, { t: "2026-02-01T00:00:00.000Z" }],
        [{ t: d }],
        [["t"]],
      ),
    ).toEqual([0, -1]);
  });

  it("is ambiguous (undefined) when the returned rows cannot be accounted for", () => {
    expect(
      mapIgnoredBatch([{ id: 1 }, { id: 2 }, { id: 3 }], [{ id: 9 }, { id: 2 }], [["id"]]),
    ).toBeUndefined();
  });
});

describe("PgDriver.close()", () => {
  it("is idempotent: a second close never ends the pool twice", async () => {
    const { PgDriver } = await import("../pg-driver");
    const driver = new PgDriver({ connectionString: "postgresql://u@127.0.0.1:1/none" });
    await driver.close();
    await expect(driver.close()).resolves.toBeUndefined();
  });
});

describe("renamed @db.default.increment primary key", () => {
  it("DDL keeps GENERATED BY DEFAULT AS IDENTITY on the renamed column", async () => {
    const driver = createMockDriver();
    const table = new AtscriptDbTable(fx.IgRenamed, new PostgresAdapter(driver)) as any;
    await table.ensureTable();
    const create = driver.calls.find((c) => c.sql.startsWith("CREATE TABLE"))!.sql;
    expect(create).toContain('"item_id" ');
    expect(create).toMatch(/"item_id" \w+ GENERATED BY DEFAULT AS IDENTITY/);
  });
});
