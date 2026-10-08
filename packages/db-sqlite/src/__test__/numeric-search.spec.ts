import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { quoteFtsTerm } from "../fts-term";
import { SqliteAdapter } from "../sqlite-adapter";
import { prepareFixtures } from "./test-utils";

// Integer members of a fulltext index (since 0.1.150): never part of the FTS5
// table, matched by `= n` when the whole term is a whole number. Also the
// FTS5 term quoting: no user text can raise a syntax error.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/numeric-search.as");
});

let driver: BetterSqlite3Driver;
beforeEach(() => {
  driver = new BetterSqlite3Driver(":memory:");
});
afterEach(() => driver.close());

async function open(Type: unknown) {
  const adapter = new SqliteAdapter(driver);
  const table = new AtscriptDbTable(Type as any, adapter);
  await table.ensureTable();
  await table.syncIndexes();
  return { table, adapter };
}

const ids = (rows: unknown[]) =>
  (rows as Array<{ id: number }>).map((r) => r.id).toSorted((a, b) => a - b);

async function seedItems() {
  const { table, adapter } = await open(fx.NsItem);
  await table.insertMany([
    { id: 1, title: "quokka login", ref_no: 29461277, alt_no: 700 },
    { id: 2, title: "payment 2946 timeout", ref_no: 15, alt_no: 29460 },
    { id: 3, title: "settings", ref_no: 2946 },
    { id: 4, title: "export", ref_no: -2946, alt_no: 12 },
    { id: 5, title: "dashboard", ref_no: 0, alt_no: 101 },
    { id: 6, title: "quokka sync", ref_no: 4242, alt_no: 2946 },
  ] as any);
  return { table, adapter };
}

describe("SqliteAdapter — integer fulltext members", () => {
  it("the FTS5 table holds the text members only", async () => {
    await seedItems();
    const cols = driver
      .all<{ name: string }>(`PRAGMA table_info("ns_items__fts__ns_ft")`)
      .map((c) => c.name);
    expect(cols).toEqual(["title"]);
  });

  it("an integer-only index creates no FTS5 table", async () => {
    await open(fx.NsCode);
    const virtual = driver
      .all<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE type='table'`)
      .filter((r) => r.sql?.startsWith("CREATE VIRTUAL TABLE"));
    expect(virtual).toEqual([]);
  });

  it("a whole-number term matches the text token OR the exact member", async () => {
    const { table } = await seedItems();
    // title token "2946" (2), ref_no 2946 (3), alt_no 2946 (6) — NOT 29461277
    expect(ids(await table.search("2946", {} as any))).toEqual([2, 3, 6]);
    expect(ids(await table.search("29461277", {} as any))).toEqual([1]);
  });

  it("a term of 0 does not match every row (no `.0` artifact)", async () => {
    const { table } = await seedItems();
    expect(ids(await table.search("0", {} as any))).toEqual([5]);
  });

  it("leading zeros and non-numbers add no numeric branch", async () => {
    const { table } = await seedItems();
    expect(await table.search("02946", {} as any)).toEqual([]);
    expect(ids(await table.search("quokka", {} as any))).toEqual([1, 6]);
  });

  it("a negative whole number is the exact member OR the text token, with no FTS5 syntax error", async () => {
    const { table } = await seedItems();
    // ref_no -2946 (4); the tokenizer drops the "-", so the text arm finds token 2946 (2)
    expect(ids(await table.search("-2946", {} as any))).toEqual([2, 4]);
  });

  it("searchWithCount counts the same population", async () => {
    const { table } = await seedItems();
    const res = await table.searchWithCount("2946", { controls: { $limit: 1 } } as any);
    expect(res.count).toBe(3);
    expect(res.data).toHaveLength(1);
    const filtered = await table.searchWithCount("2946", { filter: { id: { $gt: 2 } } } as any);
    expect(filtered.count).toBe(2);
  });

  it("grouped $search with $count agrees", async () => {
    const { table } = await seedItems();
    const rows = (await table.aggregate({
      filter: {},
      controls: { $count: true, $groupBy: ["id"], $search: "2946" },
    } as any)) as Array<{ count: number }>;
    expect(rows[0]!.count).toBe(3);
  });

  it("an integer-only index matches by number only", async () => {
    const { table } = await open(fx.NsCode);
    await table.insertMany([
      { id: 4, label: "a" },
      { id: 44, label: "b" },
    ] as any);
    expect(ids(await table.search("4", {} as any))).toEqual([4]);
    expect(ids(await table.search("04", {} as any))).toEqual([]);
    expect(await table.search("abc", {} as any)).toEqual([]);
    const res = await table.searchWithCount("abc", {} as any);
    expect(res.count).toBe(0);
  });

  it("recreates an FTS5 table that still carries an integer column", async () => {
    const { table } = await open(fx.NsItem);
    await table.insertOne({ id: 1, title: "quokka", ref_no: 7 } as any);
    // Simulate a table built when integer members were indexed as text.
    for (const suffix of ["__ai", "__ad", "__au"]) {
      driver.exec(`DROP TRIGGER IF EXISTS "ns_items__fts__ns_ft${suffix}"`);
    }
    driver.exec(`DROP TABLE "ns_items__fts__ns_ft"`);
    driver.exec(
      `CREATE VIRTUAL TABLE "ns_items__fts__ns_ft" USING fts5("title", "ref_no", content='ns_items', content_rowid='rowid')`,
    );
    await table.syncIndexes();
    const cols = driver
      .all<{ name: string }>(`PRAGMA table_info("ns_items__fts__ns_ft")`)
      .map((c) => c.name);
    expect(cols).toEqual(["title"]);
    expect(ids(await table.search("quokka", {} as any))).toEqual([1]);
  });

  it("describes integer members in the index list", async () => {
    const { adapter } = await open(fx.NsItem);
    expect(adapter.getSearchIndexes()[0]!.description).toBe(
      "FTS5 index (title) + exact number on ref_no + exact number on alt_no",
    );
  });
});

describe("SqliteAdapter — $regex on integer columns (fallback)", () => {
  it("matches the decimal text of the stored number, not its REAL rendering", async () => {
    const { table } = await open(fx.NsFallback);
    await table.insertMany([
      { id: 1, title: "a", ref_no: 29461277 },
      { id: 2, title: "b", ref_no: 15 },
      { id: 3, title: "c", ref_no: -2946 },
      { id: 4, title: "d", ref_no: 0 },
    ] as any);
    const match = async (pattern: string) =>
      ids(await table.findMany({ filter: { ref_no: { $regex: pattern } } } as any));
    expect(await match("/2946/")).toEqual([1, 3]);
    expect(await match("/^29/")).toEqual([1]);
    expect(await match("/-29/")).toEqual([3]);
    // "0" is not a substring of "29461277" (it would be of "29461277.0")
    expect(await match("/0/")).toEqual([4]);
  });
});

describe("quoteFtsTerm", () => {
  it("keeps plain words and prefix stars, quotes the rest", () => {
    expect(quoteFtsTerm("machine learning")).toBe("machine learning");
    expect(quoteFtsTerm("quok*")).toBe("quok*");
    expect(quoteFtsTerm("2946")).toBe("2946");
    expect(quoteFtsTerm("-2946")).toBe('"-2946"');
    expect(quoteFtsTerm("a AND b")).toBe('a "AND" b');
    expect(quoteFtsTerm('"exact phrase" x')).toBe('"exact phrase" x');
    expect(quoteFtsTerm("title:x")).toBe('"title:x"');
  });

  it("never yields an empty expression", () => {
    expect(quoteFtsTerm("*")).toBe('""');
    expect(quoteFtsTerm('""')).toBe('""');
  });

  it("never raises a syntax error against a real FTS5 table", async () => {
    const { table } = await open(fx.NsItem);
    await table.insertMany([
      { id: 1, title: "quokka login", ref_no: 1 },
      { id: 2, title: "a-b c_d", ref_no: 2 },
    ] as any);
    for (const term of [
      "-foo",
      "foo AND",
      "OR",
      "NOT x",
      "title:foo",
      "(",
      ")",
      '"unterminated',
      'a "b',
      "foo*bar",
      "^x",
      "NEAR(a b)",
      "*",
      "+",
      "a - b",
      "{x}",
      "'",
    ]) {
      await expect(table.search(term, {} as any)).resolves.toBeDefined();
    }
    expect(ids(await table.search("quok*", {} as any))).toEqual([1]);
    expect(ids(await table.search('"quokka login"', {} as any))).toEqual([1]);
    expect(ids(await table.search("a-b", {} as any))).toEqual([2]);
  });
});

describe("default text index", () => {
  it("is the first index with a text member, not an integer-only one declared first", async () => {
    const { adapter } = await open(fx.NsIdsFirst);
    const infos = adapter.getSearchIndexes().filter((i) => i.type === "text");
    expect(infos).toHaveLength(2);
    expect(infos.filter((i) => i.isDefault).map((i) => i.fields)).toEqual([["title"]]);
  });
});
