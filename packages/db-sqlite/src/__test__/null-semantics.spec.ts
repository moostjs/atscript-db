import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

/**
 * Finding 5 — runtime pins for the null contract the nullable typing now
 * describes: `null` in a patch clears an optional column, an omitted key
 * keeps it, `{ note: null }` filters match the cleared row and
 * `{ note: { $ne: null } }` excludes it — for optional string, number and
 * boolean columns on a real engine.
 */

type Row = Record<string, any>;
let Note: any;

describe("SQLite — null semantics on optional columns", () => {
  let driver: BetterSqlite3Driver;
  let table: AtscriptDbTable<any, Row, any, any, any, any, any>;

  beforeAll(async () => {
    await prepareFixtures();
    ({ Note } = await import("./fixtures/guard-fixtures.as"));
  });

  beforeEach(async () => {
    driver = new BetterSqlite3Driver(":memory:");
    table = new AtscriptDbTable(Note, new SqliteAdapter(driver));
    await table.ensureTable();
    await table.insertOne({ id: 1, title: "one", note: "n1", score: 5, archived: true });
    await table.insertOne({ id: 2, title: "two", note: "n2", score: 7, archived: false });
  });

  afterEach(() => {
    driver.close();
  });

  it("updateOne with null clears the column; an omitted key preserves it", async () => {
    await table.updateOne({ id: 1, note: null } as any);
    expect((await table.findById(1))!.note).toBeNull();
    await table.updateOne({ id: 1, title: "one!" } as any);
    const row = (await table.findById(1))!;
    expect(row.note).toBeNull();
    expect(row.title).toBe("one!");
    expect(row.score).toBe(5);
  });

  it("{ note: null } matches the cleared row, { note: { $ne: null } } excludes it", async () => {
    await table.updateOne({ id: 1, note: null } as any);
    const nulls = await table.findMany({ filter: { note: null } } as any);
    expect(nulls.map((r) => r.id)).toEqual([1]);
    const nonNulls = await table.findMany({ filter: { note: { $ne: null } } } as any);
    expect(nonNulls.map((r) => r.id)).toEqual([2]);
    expect(await table.count({ filter: { note: null } } as any)).toBe(1);
  });

  it("optional number and boolean columns behave the same", async () => {
    await table.updateOne({ id: 2, score: null, archived: null } as any);
    const row = (await table.findById(2))!;
    expect(row.score).toBeNull();
    expect(row.archived).toBeNull();
    expect((await table.findMany({ filter: { score: null } } as any)).map((r) => r.id)).toEqual([
      2,
    ]);
    expect((await table.findMany({ filter: { archived: null } } as any)).map((r) => r.id)).toEqual([
      2,
    ]);
    expect(
      (await table.findMany({ filter: { score: { $ne: null } } } as any)).map((r) => r.id),
    ).toEqual([1]);
    expect(
      (await table.findMany({ filter: { archived: { $ne: null } } } as any)).map((r) => r.id),
    ).toEqual([1]);
  });

  // Full replace on a SQL adapter (since 0.1.128): an UPDATE-based replace
  // assigns EVERY column, so an omitted optional column becomes NULL exactly
  // as it does on the memory / MongoDB whole-row replace.
  it("replaceOne omitting optional columns stores NULL (full replace, not a merge)", async () => {
    const before = (await table.findById(1))!;
    expect(before).toMatchObject({ note: "n1", score: 5, archived: true });
    await table.replaceOne({ id: 1, title: "one!" } as any);
    const row = (await table.findById(1))!;
    expect(row.title).toBe("one!");
    expect(row.note).toBeNull();
    expect(row.score).toBeNull();
    expect(row.archived).toBeNull();
    // The sibling row is untouched.
    expect((await table.findById(2))!).toMatchObject({ note: "n2", score: 7, archived: false });
  });

  it("an empty string is distinct from null", async () => {
    await table.updateOne({ id: 1, note: "" } as any);
    expect((await table.findById(1))!.note).toBe("");
    expect(await table.count({ filter: { note: null } } as any)).toBe(0);
  });
});
