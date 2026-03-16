import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

let ArticleType: any;

describe("SqliteAdapter FTS5 Search", () => {
  let driver: BetterSqlite3Driver;
  let adapter: SqliteAdapter;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/fts-article.as");
    ArticleType = fixtures.Article;
  });

  beforeEach(async () => {
    driver = new BetterSqlite3Driver(":memory:");
    adapter = new SqliteAdapter(driver);
    table = new AtscriptDbTable(ArticleType, adapter);
    await table.ensureTable();
    await table.syncIndexes();
  });

  afterEach(() => {
    driver.close();
  });

  // Helper to seed articles
  async function seedArticles() {
    await table.insertOne({
      title: "Introduction to Machine Learning",
      body: "Machine learning is a subset of artificial intelligence.",
      category: "tech",
    } as any);
    await table.insertOne({
      title: "Database Design Patterns",
      body: "Learn about database normalization and indexing strategies.",
      category: "tech",
    } as any);
    await table.insertOne({
      title: "Cooking with Herbs",
      body: "Fresh herbs can transform any dish into a culinary masterpiece.",
      category: "food",
    } as any);
    await table.insertOne({
      title: "Advanced Machine Learning",
      body: "Deep learning and neural networks push the boundaries of AI.",
      category: "tech",
    } as any);
  }

  // ── FTS5 sync ──────────────────────────────────────────────────────────

  describe("syncIndexes (FTS5)", () => {
    it("should create FTS5 virtual table", () => {
      const ftsTables = driver.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'articles__fts__%'`,
      );
      expect(ftsTables.map((t) => t.name)).toContain("articles__fts__articles_ft");
    });

    it("should create sync triggers", () => {
      const triggers = driver.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'articles__fts__%'`,
      );
      const names = triggers.map((t) => t.name);
      expect(names).toContain("articles__fts__articles_ft__ai");
      expect(names).toContain("articles__fts__articles_ft__ad");
      expect(names).toContain("articles__fts__articles_ft__au");
    });

    it("should be idempotent", async () => {
      await table.syncIndexes();
      await table.syncIndexes();

      const ftsTables = driver
        .all<{ name: string; sql: string }>(
          `SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE 'articles__fts__%'`,
        )
        .filter((r) => r.sql.startsWith("CREATE VIRTUAL TABLE"));
      expect(ftsTables).toHaveLength(1);
    });
  });

  // ── Search metadata ────────────────────────────────────────────────────

  describe("getSearchIndexes / isSearchable", () => {
    it("should return fulltext index metadata", () => {
      const indexes = adapter.getSearchIndexes();
      expect(indexes).toHaveLength(1);
      expect(indexes[0].name).toBe("articles_ft");
      expect(indexes[0].type).toBe("text");
    });

    it("should report searchable", () => {
      expect(adapter.isSearchable()).toBe(true);
    });
  });

  // ── search() ───────────────────────────────────────────────────────────

  describe("search", () => {
    beforeEach(seedArticles);

    it("should return matching rows", async () => {
      const results = await table.search("machine learning", { filter: {}, controls: {} } as any);
      expect(results.length).toBeGreaterThan(0);
      const titles = results.map((r: any) => r.title);
      expect(titles).toContain("Introduction to Machine Learning");
    });

    it("should combine search with filter", async () => {
      const results = await table.search("database", {
        filter: { category: "tech" },
        controls: {},
      } as any);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect((r as any).category).toBe("tech");
      }
    });

    it("should respect $limit", async () => {
      const results = await table.search("machine", { filter: {}, controls: { $limit: 1 } } as any);
      expect(results).toHaveLength(1);
    });

    it("should return empty array for no matches", async () => {
      const results = await table.search("xyznonexistentterm123", {
        filter: {},
        controls: {},
      } as any);
      expect(results).toHaveLength(0);
    });

    it("should return empty array for empty search text", async () => {
      const results = await table.search("", { filter: {}, controls: {} } as any);
      expect(results).toHaveLength(0);
      const results2 = await table.search("   ", { filter: {}, controls: {} } as any);
      expect(results2).toHaveLength(0);
    });

    it("should throw for nonexistent index name", async () => {
      await expect(
        table.search("test", { filter: {}, controls: {} } as any, "nonexistent"),
      ).rejects.toThrow('Search index "nonexistent" not found');
    });
  });

  // ── searchWithCount() ──────────────────────────────────────────────────

  describe("searchWithCount", () => {
    beforeEach(seedArticles);

    it("should return data and count", async () => {
      const result = await table.searchWithCount("machine", { filter: {}, controls: {} } as any);
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.count).toBe(result.data.length);
    });

    it("should return correct count ignoring limit", async () => {
      const result = await table.searchWithCount("machine", {
        filter: {},
        controls: { $limit: 1 },
      } as any);
      expect(result.data).toHaveLength(1);
      expect(result.count).toBe(2); // Two articles match "machine"
    });
  });

  // ── Trigger sync ───────────────────────────────────────────────────────

  describe("trigger sync", () => {
    it("should index rows inserted after FTS creation", async () => {
      await table.insertOne({
        title: "Late Article",
        body: "This was added after FTS setup.",
        category: "misc",
      } as any);
      const results = await table.search("Late Article", { filter: {}, controls: {} } as any);
      expect(results).toHaveLength(1);
    });

    it("should remove deleted rows from FTS index", async () => {
      await table.insertOne({
        title: "Temporary Article",
        body: "Will be deleted soon.",
        category: "misc",
      } as any);
      // Verify it's found
      let results = await table.search("Temporary", { filter: {}, controls: {} } as any);
      expect(results).toHaveLength(1);
      // Delete and verify it's gone
      await table.deleteMany({ title: "Temporary Article" } as any);
      results = await table.search("Temporary", { filter: {}, controls: {} } as any);
      expect(results).toHaveLength(0);
    });

    it("should update FTS index on row update", async () => {
      await table.insertOne({
        title: "Unique Zebra",
        body: "Unique Zebra body.",
        category: "misc",
      } as any);
      let results = await table.search("Zebra", { filter: {}, controls: {} } as any);
      expect(results).toHaveLength(1);

      // Update both indexed fields so "Zebra" is fully removed
      await table.updateMany(
        { title: "Unique Zebra" } as any,
        { title: "Changed Giraffe", body: "Changed Giraffe body." } as any,
      );
      // Old term should not match
      results = await table.search("Zebra", { filter: {}, controls: {} } as any);
      expect(results).toHaveLength(0);
      // New term should match
      results = await table.search("Giraffe", { filter: {}, controls: {} } as any);
      expect(results).toHaveLength(1);
    });
  });

  // ── Cleanup ────────────────────────────────────────────────────────────

  describe("dropTable", () => {
    it("should remove FTS tables and triggers", async () => {
      await adapter.dropTable();

      const ftsTables = driver.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'articles__fts__%'`,
      );
      expect(ftsTables).toHaveLength(0);

      const triggers = driver.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'articles__fts__%'`,
      );
      expect(triggers).toHaveLength(0);
    });
  });
});
