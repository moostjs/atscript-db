import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

let UpItem: any;

/**
 * `undefined` write props on a real SQLite connection (since 0.1.128).
 * SQLite handles `@db.default` natively (DDL DEFAULT): before pruning, an
 * `undefined` value on a defaulted NOT NULL column was bound as NULL and
 * failed the constraint; now the column is omitted and the DEFAULT applies.
 */
describe("undefined write props on SQLite", () => {
  let driver: BetterSqlite3Driver;
  let items: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    UpItem = (await import("./fixtures/undefined-props.as")).UpItem;
  });

  beforeEach(async () => {
    driver = new BetterSqlite3Driver(":memory:");
    items = new AtscriptDbTable(UpItem, new SqliteAdapter(driver));
    await items.ensureTable();
  });

  afterEach(() => {
    driver.close();
  });

  const read = async (id: number) =>
    (await items.findOne({ filter: { id }, controls: {} })) as Record<string, any>;

  it("insert: undefined on a defaulted NOT NULL column applies the DDL DEFAULT", async () => {
    await items.insertOne({ id: 1, name: "a", cap: undefined, note: undefined } as any);
    const row = await read(1);
    expect(row.cap).toBe(10000);
    expect(row.note ?? null).toBeNull();
    expect(typeof row.createdAt).toBe("number");
  });

  it("insert: null is an explicit NULL on an optional column", async () => {
    await items.insertOne({ id: 1, name: "a", note: null } as any);
    expect((await read(1)).note).toBeNull();
  });

  it("insertMany: prunes per row", async () => {
    await items.insertMany([
      { id: 1, name: "a", cap: undefined },
      { id: 2, name: "b", cap: 5 },
    ] as any[]);
    expect((await read(1)).cap).toBe(10000);
    expect((await read(2)).cap).toBe(5);
  });

  // PG / MySQL once took the column list from the first row only, dropping a
  // column absent from row 1 for every row. SQLite inserts row by row (it has
  // no `DEFAULT` keyword inside VALUES), so each row stores exactly what a
  // single-row insert of it would: its own columns, DDL DEFAULT for the rest.
  it("insertMany: rows of different shapes each keep their own columns", async () => {
    await items.insertMany([
      { id: 1, name: "a" },
      { id: 2, name: "b", cap: 5, note: "second" },
      { id: 3, name: "c", note: "third" },
    ] as any[]);
    await items.insertOne({ id: 4, name: "d", note: "third" } as any);
    expect([(await read(1)).cap, (await read(1)).note ?? null]).toEqual([10000, null]);
    expect([(await read(2)).cap, (await read(2)).note]).toEqual([5, "second"]);
    const { id: _3, name: _c, createdAt: _t3, ...third } = await read(3);
    const { id: _4, name: _d, createdAt: _t4, ...single } = await read(4);
    expect(third).toEqual(single);
    expect(third.cap).toBe(10000);
    expect(third.note).toBe("third");
  });

  it("patch: undefined leaves the previous value untouched; null clears it", async () => {
    await items.insertOne({ id: 1, name: "a", note: "keep me" } as any);
    await items.updateOne({ id: 1, name: "b", note: undefined } as any);
    expect((await read(1)).note).toBe("keep me");
    await items.updateOne({ id: 1, note: null } as any);
    expect((await read(1)).note).toBeNull();
  });

  it("patch: merge-strategy leaf undefined is untouched", async () => {
    await items.insertOne({ id: 1, name: "a", stats: { views: 1, rating: 5 } } as any);
    await items.updateOne({ id: 1, stats: { views: 2, rating: undefined } } as any);
    const row = await read(1);
    expect(row.stats.views).toBe(2);
    expect(row.stats.rating).toBe(5);
  });

  // WHY (review #7): a flattened non-merge object has REPLACE semantics — an
  // undefined optional leaf behaves exactly like omitting it (null-filled).
  it("patch: flattened non-merge leaf undefined ≡ omitted (null-filled, replace semantics)", async () => {
    await items.insertOne({ id: 1, name: "a", address: { city: "X", line2: "old" } } as any);
    await items.updateOne({ id: 1, address: { city: "Y", line2: undefined } } as any);
    const row = await read(1);
    expect(row.address.city).toBe("Y");
    expect(row.address.line2 ?? null).toBeNull();
  });

  it("updateMany / replaceMany: undefined never reaches the SET list", async () => {
    await items.insertOne({ id: 1, name: "a", note: "n1" } as any);
    await items.updateMany({ id: 1 } as any, { name: "z", note: undefined } as any);
    expect((await read(1)).note).toBe("n1");
    await items.replaceMany({ id: 1 } as any, { name: "r", cap: 3, note: undefined } as any);
    const row = await read(1);
    expect(row.name).toBe("r");
    expect(row.note).toBe("n1");
  });
});
