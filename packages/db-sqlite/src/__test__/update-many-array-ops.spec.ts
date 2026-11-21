import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable, DbError } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures, RecordingDriver } from "./test-utils";

let UmaItem: any;
let UmaPair: any;

// `updateMany` with `$insert` / `$upsert` / `$update` / `$remove` (since
// 0.1.182; 0.1.180 – 0.1.181 refused them): every matched row ends with the
// array `updateOne` gives it. SQLite reads the keys of the matched rows, then
// their operator columns, and writes each row by its primary key — one
// transaction for the call.

/** Rows with different stored arrays — the third holds none. */
const rows = () => [
  {
    id: 1,
    status: "open",
    code: "c1",
    tags: ["t1", "old"],
    uniq: ["u"],
    variants: [
      { sku: "a", qty: 1, note: "keep" },
      { sku: "b", qty: 5 },
    ],
    attrs: [{ name: "w", value: "1", unit: "g" }],
    notes: [{ text: "x" }, { text: "y", author: "bob" }],
    box: { labels: ["l1"] },
    seen: [],
  },
  {
    id: 2,
    status: "open",
    code: "c2",
    tags: ["old"],
    uniq: ["v", "w"],
    variants: [{ sku: "c", qty: 3 }],
    attrs: [],
    notes: [{ text: "y", author: "bob" }],
    box: { labels: [] },
    seen: ["s"],
  },
  { id: 3, status: "open", code: "c3" },
  { id: 4, status: "closed", code: "c4", tags: ["old"] },
];

const patch = {
  status: "done",
  tags: { $remove: ["old"], $insert: ["new"] },
  uniq: { $insert: ["w", "z"] },
  variants: { $update: [{ sku: "a", qty: 2 }], $insert: [{ sku: "n", qty: 1 }] },
  attrs: { $upsert: [{ name: "w", value: "2" }] },
  notes: { $remove: [{ text: "y", author: "bob" }] },
  box: { labels: { $insert: ["l2"] } },
};

/** The rows of `table` in `id` order. */
const all = async (table: AtscriptDbTable) =>
  (await table.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];

describe("SqliteAdapter — updateMany with array operators", () => {
  let inner: BetterSqlite3Driver;
  let driver: RecordingDriver;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ({ UmaItem, UmaPair } = await import("./fixtures/update-many-array-ops.as"));
  });

  beforeEach(async () => {
    inner = new BetterSqlite3Driver(":memory:");
    driver = new RecordingDriver(inner);
    table = new AtscriptDbTable(UmaItem, new SqliteAdapter(driver));
    await table.ensureTable();
    await table.syncIndexes();
    await table.insertMany(rows() as any);
    driver.statements.length = 0;
    driver.execs.length = 0;
  });

  afterEach(() => inner.close());

  const updates = () => driver.statements.filter((s) => s.startsWith("UPDATE"));

  it("every matched row gets its own result — the one updateOne gives it", async () => {
    expect(await table.updateMany({ status: "open" }, patch as any)).toEqual({
      matchedCount: 3,
      modifiedCount: 3,
    });
    const many = await all(table);

    const otherDriver = new BetterSqlite3Driver(":memory:");
    try {
      const other = new AtscriptDbTable(UmaItem, new SqliteAdapter(otherDriver));
      await other.ensureTable();
      await other.insertMany(rows() as any);
      for (const id of [1, 2, 3]) await other.updateOne({ id, ...patch } as any);
      expect(many).toEqual(await all(other));
    } finally {
      otherDriver.close();
    }

    expect(many.map((row) => row.tags)).toEqual([["t1", "new"], ["new"], ["new"], ["old"]]);
    expect(many.map((row) => row.variants)).toEqual([
      [
        { sku: "a", qty: 2 },
        { sku: "b", qty: 5 },
        { sku: "n", qty: 1 },
      ],
      [
        { sku: "c", qty: 3 },
        { sku: "n", qty: 1 },
      ],
      [{ sku: "n", qty: 1 }],
      null,
    ]);
    expect(many.map((row) => row.attrs)).toEqual([
      [{ name: "w", value: "2", unit: "g" }],
      [{ name: "w", value: "2" }],
      [{ name: "w", value: "2" }],
      null,
    ]);
    expect(many.map((row) => row.uniq)).toEqual([
      ["u", "w", "z"],
      ["v", "w", "z"],
      ["w", "z"],
      null,
    ]);
    expect(many.map((row) => row.notes)).toEqual([[{ text: "x" }], [], [], null]);
    expect(many.map((row) => row.box?.labels)).toEqual([["l1", "l2"], ["l2"], ["l2"], undefined]);
    expect(many.map((row) => [row.status, row.version])).toEqual([
      ["done", 1],
      ["done", 1],
      ["done", 1],
      ["closed", 0],
    ]);
  });

  it("one transaction: the keys, then the operator columns by key, then one UPDATE per row by key", async () => {
    await table.updateMany({ status: "open" }, { tags: { $insert: ["x"] } } as any);
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    const [pick, batch, ...writes] = driver.statements;
    expect(pick).toMatch(/^SELECT "id" FROM "uma_items" WHERE "status" = \? ORDER BY "id" ASC/);
    expect(batch).toMatch(/^SELECT "id", "tags" FROM "uma_items" WHERE "id" IN \(\?, \?, \?\)/);
    expect(writes).toHaveLength(3);
    for (const sql of writes) {
      expect(sql).toMatch(
        /^UPDATE "uma_items" SET "tags" = \?, "version" = "version" \+ 1 WHERE "id" = \?$/,
      );
    }
  });

  it("without array operators: one UPDATE, no read, no transaction (unchanged)", async () => {
    await table.updateMany({ status: "open" }, { status: "done", tags: ["a"] } as any);
    expect(driver.execs).toEqual([]);
    expect(driver.statements).toHaveLength(1);
    expect(driver.statements[0]).toMatch(/^UPDATE "uma_items" SET .* WHERE "status" = \?$/);
  });

  it("a version-exempt patch keeps every row's version; a mixed one bumps each by one", async () => {
    await table.updateMany({}, { seen: { $insert: ["s2"] } } as any);
    let stored = await all(table);
    expect(stored.map((row) => [row.seen, row.version])).toEqual([
      [["s2"], 0],
      [["s", "s2"], 0],
      [["s2"], 0],
      [["s2"], 0],
    ]);
    for (const sql of updates()) expect(sql).not.toContain('"version"');

    await table.updateMany({}, { status: "x", seen: { $remove: ["s"] } } as any);
    stored = await all(table);
    expect(stored.map((row) => [row.seen, row.version])).toEqual([
      [["s2"], 1],
      [["s2"], 1],
      [["s2"], 1],
      [["s2"], 1],
    ]);
  });

  it("a bounded write takes `limit` rows in sort order; looping until 0 patches each row once", async () => {
    const rounds: number[] = [];
    for (;;) {
      const { matchedCount } = await table.updateMany(
        { status: "open" },
        { status: "seen", tags: { $insert: ["x"] } } as any,
        { limit: 2, sort: { id: -1 } },
      );
      rounds.push(matchedCount);
      if (matchedCount === 0) break;
    }
    expect(rounds).toEqual([2, 1, 0]);
    expect((await all(table)).map((row) => row.tags)).toEqual([
      ["t1", "old", "x"],
      ["old", "x"],
      ["x"],
      ["old"],
    ]);
  });

  it("a composite primary key", async () => {
    const pairs = new AtscriptDbTable(UmaPair, new SqliteAdapter(driver));
    await pairs.ensureTable();
    await pairs.insertMany([
      { org: "a", code: 1, tags: ["x"] },
      { org: "a", code: 2 },
      { org: "b", code: 1, tags: ["y"] },
    ] as any);
    driver.statements.length = 0;
    expect(await pairs.updateMany({ org: "a" }, { tags: { $insert: ["n"] } } as any)).toEqual({
      matchedCount: 2,
      modifiedCount: 2,
    });
    expect(updates()).toEqual([
      'UPDATE "uma_pairs" SET "tags" = ? WHERE "org" = ? AND "code" = ?',
      'UPDATE "uma_pairs" SET "tags" = ? WHERE "org" = ? AND "code" = ?',
    ]);
    const stored = (await pairs.findMany({
      filter: {},
      controls: { $sort: { org: 1, code: 1 } },
    })) as any[];
    expect(stored.map((row) => row.tags)).toEqual([["x", "n"], ["n"], ["y"]]);
  });

  it("zero matches: { 0, 0 } and no UPDATE", async () => {
    expect(await table.updateMany({ status: "none" }, patch as any)).toEqual({
      matchedCount: 0,
      modifiedCount: 0,
    });
    expect(updates()).toEqual([]);
  });

  it("a row that fails rolls the whole call back", async () => {
    const before = await all(table);
    // every row takes the same unique `code`: the second row conflicts
    const error = await table
      .updateMany({ status: "open" }, { code: "same", tags: { $insert: ["x"] } } as any)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("CONFLICT");
    expect(updates().length).toBeGreaterThanOrEqual(2);
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
    expect(await all(table)).toEqual(before);
  });

  it("a stored value that is not an array fails the call; nothing is written", async () => {
    inner.run(`UPDATE "uma_items" SET "tags" = '"abc"' WHERE "id" = 2`);
    const before = await all(table);
    await expect(
      table.updateMany({ status: "open" }, { tags: { $insert: ["x"] } } as any),
    ).rejects.toThrow(
      'Cannot apply array patch operators to "tags": its stored value is not an array',
    );
    expect(await all(table)).toEqual(before);
  });

  // SQLite's transaction holds the write lock (`BEGIN IMMEDIATE`), so the row
  // lock the read-modify-write asks for since 0.1.182 renders nothing here
  it("updateOne with an operator: the same plain read and write as before", async () => {
    await table.updateOne({ id: 1, tags: { $insert: ["x"] } } as any);
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    expect(driver.statements).toHaveLength(2);
    expect(driver.statements[0]).toMatch(/^SELECT \* FROM "uma_items" WHERE "id" = \? LIMIT \?$/);
    expect(driver.statements.join("\n")).not.toContain("FOR UPDATE");
    expect((await all(table))[0].tags).toEqual(["t1", "old", "x"]);
  });

  it("inside a caller's transaction it joins it — and rolls back with it", async () => {
    const before = await all(table);
    await expect(
      table.getAdapter().withTransaction(async () => {
        await table.updateMany({}, { tags: { $insert: ["x"] } } as any);
        throw new Error("caller rollback");
      }),
    ).rejects.toThrow("caller rollback");
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
    expect(await all(table)).toEqual(before);
  });
});
