import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures, RecordingDriver } from "./test-utils";

/** Records every READ statement, so a spec can assert what SQL a grouped search
 *  actually emitted (no injected ORDER BY / LIMIT). `RecordingDriver` already
 *  records `exec`; this adds the read side, per its "subclass per spec" note. */
class QueryRecorder extends RecordingDriver {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  override all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    this.queries.push({ sql, params: params ?? [] });
    return super.all<T>(sql, params);
  }
  override get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    this.queries.push({ sql, params: params ?? [] });
    return super.get<T>(sql, params);
  }
  /** The last statement the adapter ran. */
  last(): { sql: string; params: unknown[] } {
    return this.queries.at(-1)!;
  }
}

let ArticleType: any;
let NoteType: any;

const CNT = { $fn: "count", $field: "*", $as: "cnt" } as const;

describe("SqliteAdapter aggregate + $search (FTS5)", () => {
  let inner: BetterSqlite3Driver;
  let driver: QueryRecorder;
  let adapter: SqliteAdapter;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ArticleType = (await import("./fixtures/fts-article.as")).Article;
    NoteType = (await import("./fixtures/fts-notes.as")).Note;
  });

  beforeEach(async () => {
    inner = new BetterSqlite3Driver(":memory:");
    driver = new QueryRecorder(inner);
    adapter = new SqliteAdapter(driver);
    table = new AtscriptDbTable(ArticleType, adapter);
    await table.ensureTable();
    await table.syncIndexes();

    // 6 rows / 3 categories. "machine" matches 2 tech + 1 food, and no travel
    // row at all — so search must drop a whole group, not just trim one.
    await table.insertMany([
      { title: "Machine Learning Basics", body: "Neural networks explained.", category: "tech" },
      { title: "Database Design", body: "Indexing strategies.", category: "tech" },
      { title: "Machine Vision", body: "Cameras and pipelines.", category: "tech" },
      { title: "Machine Roasted Coffee", body: "Beans and brewing.", category: "food" },
      { title: "Bread Baking", body: "Slow fermentation.", category: "food" },
      { title: "Island Hopping", body: "Ferries and ports.", category: "travel" },
    ] as any);
    driver.queries.length = 0;
  });

  afterEach(() => {
    inner.close();
  });

  const groupByCategory = (extra: Record<string, unknown> = {}) =>
    table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["category"],
        $select: ["category", CNT] as any,
        $sort: { category: 1 } as any,
        ...extra,
      },
    });

  // ── The defect ─────────────────────────────────────────────────────────

  it("grouped counts match the leaf search(), not the whole table", async () => {
    const leaf = await table.search("machine", { filter: {}, controls: {} } as any);
    const byCategory = new Map<string, number>();
    for (const row of leaf as any[]) {
      byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);
    }
    expect([...byCategory.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ["food", 1],
      ["tech", 2],
    ]);

    const grouped = await groupByCategory({ $search: "machine" });
    expect(grouped).toEqual([
      { category: "food", cnt: 1 },
      { category: "tech", cnt: 2 },
    ]);

    // …and it is genuinely different from the unsearched rollup.
    expect(await groupByCategory()).toEqual([
      { category: "food", cnt: 2 },
      { category: "tech", cnt: 3 },
      { category: "travel", cnt: 1 },
    ]);
  });

  it("aggregates other than count are computed over matching rows only", async () => {
    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["category"],
        $select: ["category", { $fn: "min", $field: "title", $as: "first" }] as any,
        $sort: { category: 1 } as any,
        $search: "machine",
      },
    });
    expect(result).toEqual([
      { category: "food", first: "Machine Roasted Coffee" },
      { category: "tech", first: "Machine Learning Basics" },
    ]);
  });

  it("$search composes with the pre-aggregation filter", async () => {
    const result = await table.aggregate({
      filter: { category: "tech" },
      controls: { $groupBy: ["category"], $select: ["category", CNT] as any, $search: "machine" },
    });
    expect(result).toEqual([{ category: "tech", cnt: 2 }]);
    // MATCH param first, then the filter's — the order the SQL renders them in.
    expect(driver.last().params).toEqual(["machine", "tech"]);
  });

  it("returns no groups when nothing matches", async () => {
    expect(await groupByCategory({ $search: "xyznonexistentterm123" })).toEqual([]);
  });

  // ── $count ─────────────────────────────────────────────────────────────

  it("$count returns the number of groups that survive the search", async () => {
    const searched = await table.aggregate({
      filter: {},
      controls: { $groupBy: ["category"], $count: true, $search: "machine" },
    });
    expect(searched).toEqual([{ count: 2 }]); // tech + food, travel gone

    const all = await table.aggregate({
      filter: {},
      controls: { $groupBy: ["category"], $count: true },
    });
    expect(all).toEqual([{ count: 3 }]);
  });

  it("$count agrees with the row set it counts", async () => {
    const rows = await groupByCategory({ $search: "machine" });
    const [{ count }] = (await table.aggregate({
      filter: {},
      controls: { $groupBy: ["category"], $count: true, $search: "machine" },
    })) as any[];
    expect(count).toBe(rows.length);
  });

  // ── $having ────────────────────────────────────────────────────────────

  it("$search and $having compose (rows, then groups)", async () => {
    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["category"],
        $select: ["category", CNT] as any,
        $having: { cnt: { $gte: 2 } } as any,
        $search: "machine",
      },
    });
    // food has 1 match → dropped by HAVING; tech has 2 → kept.
    expect(result).toEqual([{ category: "tech", cnt: 2 }]);
    // WHERE's MATCH param precedes HAVING's, matching the rendered order.
    expect(driver.last().params).toEqual(["machine", 2]);
  });

  it("$count + $having + $search counts the surviving groups", async () => {
    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["category"],
        $select: ["category", CNT] as any,
        $having: { cnt: { $gte: 2 } } as any,
        $count: true,
        $search: "machine",
      },
    });
    expect(result).toEqual([{ count: 1 }]);
    expect(driver.last().params).toEqual(["machine", 2]);
  });

  // ── No implicit ordering / capping ─────────────────────────────────────

  it("injects no ORDER BY, no LIMIT and no relevance ranking", async () => {
    await table.aggregate({
      filter: {},
      controls: { $groupBy: ["category"], $select: ["category", CNT] as any, $search: "machine" },
    });
    const { sql } = driver.last();
    expect(sql).not.toMatch(/\bORDER BY\b/i);
    expect(sql).not.toMatch(/\bLIMIT\b/i);
    expect(sql).not.toMatch(/\brank\b|\bbm25\b/i);
  });

  it("honours the caller's $sort / $limit / $skip verbatim", async () => {
    const result = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["category"],
        $select: ["category", CNT] as any,
        $sort: { cnt: -1 } as any,
        $limit: 1,
        $search: "machine",
      },
    });
    expect(result).toEqual([{ category: "tech", cnt: 2 }]);
    const { sql, params } = driver.last();
    expect(sql).toMatch(/ORDER BY "cnt" DESC LIMIT \?$/);
    expect(params).toEqual(["machine", 1]);

    const skipped = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["category"],
        $select: ["category", CNT] as any,
        $sort: { cnt: -1 } as any,
        $skip: 1,
        $search: "machine",
      },
    });
    expect(skipped).toEqual([{ category: "food", cnt: 1 }]);
  });

  // ── Emitted SQL ────────────────────────────────────────────────────────

  it("emits the FTS match as a plain WHERE fragment the aggregate builders accept", async () => {
    await table.aggregate({
      filter: {},
      controls: { $groupBy: ["category"], $select: ["category", CNT] as any, $search: "machine" },
    });
    expect(driver.last()).toEqual({
      sql:
        `SELECT "category", COUNT(*) AS "cnt" FROM "articles" WHERE rowid IN ` +
        `(SELECT rowid FROM "articles__fts__articles_ft" WHERE "articles__fts__articles_ft" MATCH ?) ` +
        `GROUP BY "category"`,
      params: ["machine"],
    });

    await table.aggregate({
      filter: {},
      controls: { $groupBy: ["category"], $count: true, $search: "machine" },
    });
    expect(driver.last()).toEqual({
      sql:
        `SELECT COUNT(*) AS "count" FROM (SELECT 1 FROM "articles" WHERE rowid IN ` +
        `(SELECT rowid FROM "articles__fts__articles_ft" WHERE "articles__fts__articles_ft" MATCH ?) ` +
        `GROUP BY "category") AS "_groups"`,
      params: ["machine"],
    });
  });

  // ── No $search: byte-identical to before ───────────────────────────────

  it("leaves the unsearched grouped path untouched", async () => {
    await table.aggregate({
      filter: {},
      controls: { $groupBy: ["category"], $select: ["category", CNT] as any },
    });
    expect(driver.last()).toEqual({
      sql: `SELECT "category", COUNT(*) AS "cnt" FROM "articles" WHERE 1=1 GROUP BY "category"`,
      params: [],
    });

    await table.aggregate({ filter: {}, controls: { $groupBy: ["category"], $count: true } });
    expect(driver.last()).toEqual({
      sql: `SELECT COUNT(*) AS "count" FROM (SELECT 1 FROM "articles" WHERE 1=1 GROUP BY "category") AS "_groups"`,
      params: [],
    });
  });

  it("treats an empty / blank / non-string $search as absent", async () => {
    for (const $search of ["", "   ", undefined, 42]) {
      await table.aggregate({
        filter: {},
        controls: { $groupBy: ["category"], $select: ["category", CNT] as any, $search } as any,
      });
      expect(driver.last().sql).toBe(
        `SELECT "category", COUNT(*) AS "cnt" FROM "articles" WHERE 1=1 GROUP BY "category"`,
      );
    }
  });

  // ── $index ─────────────────────────────────────────────────────────────

  describe("$index", () => {
    let notes: AtscriptDbTable;

    beforeEach(async () => {
      notes = new AtscriptDbTable(NoteType, adapter);
      await notes.ensureTable();
      await notes.syncIndexes();
      await notes.insertMany([
        { title: "alpha report", body: "nothing to see", category: "titled" },
        { title: "plain heading", body: "alpha lives in the body", category: "bodied" },
      ] as any);
      driver.queries.length = 0;
    });

    const grouped = ($index?: string) =>
      notes.aggregate({
        filter: {},
        controls: {
          $groupBy: ["category"],
          $select: ["category", CNT] as any,
          $search: "alpha",
          $index,
        } as any,
      });

    it("targets the named FTS table", async () => {
      expect(await grouped("notes_title_ft")).toEqual([{ category: "titled", cnt: 1 }]);
      expect(driver.last().sql).toContain(`"notes__fts__notes_title_ft" MATCH ?`);

      expect(await grouped("notes_body_ft")).toEqual([{ category: "bodied", cnt: 1 }]);
      expect(driver.last().sql).toContain(`"notes__fts__notes_body_ft" MATCH ?`);
    });

    it("falls back to the first index when $index is omitted", async () => {
      const first = notes.getSearchIndexes().find((i) => i.type === "text")!.name;
      await grouped();
      expect(driver.last().sql).toContain(`"notes__fts__${first}" MATCH ?`);
    });

    it("rejects an unknown $index exactly like the leaf search does", async () => {
      await expect(grouped("nonexistent")).rejects.toThrow('Search index "nonexistent" not found');
      await expect(
        notes.search("alpha", { filter: {}, controls: {} } as any, "nonexistent"),
      ).rejects.toThrow('Search index "nonexistent" not found');
    });
  });
});
