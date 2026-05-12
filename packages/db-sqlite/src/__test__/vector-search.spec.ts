import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

// Skip the real-extension suite when sqlite-vec can't load (CI without
// prebuilt binaries). The JSON-TEXT fallback path is covered by the
// dedicated `describe` block at the bottom and runs unconditionally.
let sqliteVecAvailable = true;
try {
  const probe = new BetterSqlite3Driver(":memory:", { vector: true });
  probe.close();
} catch {
  sqliteVecAvailable = false;
}

const dscribe = sqliteVecAvailable ? describe : describe.skip;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds a 512-d cosine-friendly vector with a small handful of non-zero
 * positions. Keeps tests cheap and the geometry easy to reason about.
 */
function sparseVec(dims: number, positions: Record<number, number>): number[] {
  const v = Array.from<number>({ length: dims }).fill(0);
  for (const [idxStr, value] of Object.entries(positions)) {
    v[Number(idxStr)] = value;
  }
  return v;
}

/** L2-normalises a vector so cosine distance is well-defined. */
function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) {
    sum += x * x;
  }
  const mag = Math.sqrt(sum);
  if (mag === 0) {
    return v.slice();
  }
  return v.map((x) => x / mag);
}

/** Builds a 512-d unit vector with weight `1` on a single dimension. */
function basis(dims: number, idx: number): number[] {
  return normalize(sparseVec(dims, { [idx]: 1 }));
}

const DIMS_512 = 512;

// ── Fixture types (populated in beforeAll) ───────────────────────────────────
let DocumentType: any;
let ArticleType: any;
let PointType: any;
let RenamedDocType: any;
let NoVectorType: any;

// ── Real-extension suite ────────────────────────────────────────────────────

dscribe("SqliteAdapter vector search (real sqlite-vec)", () => {
  let driver: BetterSqlite3Driver;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/vector-table.as");
    DocumentType = fixtures.Document;
    ArticleType = fixtures.Article;
    PointType = fixtures.Point;
    RenamedDocType = fixtures.RenamedDoc;
    NoVectorType = fixtures.NoVector;
  });

  afterEach(() => {
    try {
      driver?.close();
    } catch {
      // already closed
    }
  });

  function makeTable(Type: any): {
    driver: BetterSqlite3Driver;
    adapter: SqliteAdapter;
    table: AtscriptDbTable;
  } {
    const drv = new BetterSqlite3Driver(":memory:", { vector: true });
    const adapter = new SqliteAdapter(drv);
    const table = new AtscriptDbTable(Type, adapter);
    return { driver: drv, adapter, table };
  }

  // ── Schema / indexes ──────────────────────────────────────────────────────

  describe("schema and indexes", () => {
    let adapter: SqliteAdapter;
    let table: AtscriptDbTable;

    beforeEach(async () => {
      ({ driver, adapter, table } = makeTable(DocumentType));
      await table.ensureTable();
      await table.syncIndexes();
    });

    it("creates BLOB column for vector field", () => {
      const cols = driver.all<{ name: string; type: string }>(`PRAGMA table_info("documents")`);
      const emb = cols.find((c) => c.name === "embedding");
      expect(emb).toBeDefined();
      expect(emb!.type).toBe("BLOB");
    });

    it("creates vec0 shadow table with correct DDL", () => {
      const row = driver.get<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
        ["documents__vec__embedding"],
      );
      expect(row).not.toBeNull();
      expect(row!.sql).toContain("USING vec0");
      expect(row!.sql).toContain("embedding float[512]");
      expect(row!.sql).toContain("distance_metric=cosine");
    });

    it("creates AI/AU/AD triggers", () => {
      const triggers = driver.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'documents__vec__embedding__%'`,
      );
      const names = triggers.map((t) => t.name).toSorted();
      expect(names).toContain("documents__vec__embedding__ai");
      expect(names).toContain("documents__vec__embedding__ad");
      expect(names).toContain("documents__vec__embedding__au");
    });

    it("creates partition columns in DDL", async () => {
      driver.close();
      ({ driver, adapter, table } = makeTable(ArticleType));
      await table.ensureTable();
      await table.syncIndexes();

      const row = driver.get<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
        ["articles__vec__embedding"],
      );
      expect(row).not.toBeNull();
      // vec0's DDL parser requires bare (unquoted) partition column names
      expect(row!.sql).toContain(`category TEXT partition key`);
      expect(row!.sql).toContain(`status TEXT partition key`);
    });

    it("getSearchIndexes returns vector entry", () => {
      const indexes = adapter.getSearchIndexes();
      const vec = indexes.find((i) => i.type === "vector");
      expect(vec).toBeDefined();
      expect(vec!.name).toBe("embedding");
      expect(vec!.description).toMatch(/vec0|embedding|512|cosine/);
    });
  });

  // ── CRUD propagation to vec0 shadow ──────────────────────────────────────

  describe("CRUD propagation to vec0", () => {
    let adapter: SqliteAdapter;
    let table: AtscriptDbTable;

    beforeEach(async () => {
      ({ driver, adapter, table } = makeTable(DocumentType));
      await table.ensureTable();
      await table.syncIndexes();
    });

    it("inserts row → vec0 row appears via trigger", async () => {
      const { insertedId } = await table.insertOne({
        id: "d1",
        title: "First",
        embedding: basis(DIMS_512, 0),
      } as any);

      const mainRow = driver.get<{ rowid: number }>(`SELECT rowid FROM "documents" WHERE id = ?`, [
        insertedId,
      ]);
      expect(mainRow).not.toBeNull();

      const shadowRow = driver.get<{ rowid: number }>(
        `SELECT rowid FROM "documents__vec__embedding" WHERE rowid = ?`,
        [mainRow!.rowid],
      );
      expect(shadowRow).not.toBeNull();
      expect(shadowRow!.rowid).toBe(mainRow!.rowid);
    });

    it("updates embedding → vec0 row is replaced", async () => {
      await table.insertOne({
        id: "d1",
        title: "Doc",
        embedding: basis(DIMS_512, 0),
      } as any);

      // After update, the closest vector to basis(0) should still be d1 only
      // if the shadow row was updated; otherwise the old [1,0,...] embedding
      // would dominate the basis(0) query.
      await table.updateMany(
        { id: "d1" } as any,
        {
          embedding: basis(DIMS_512, 5),
        } as any,
      );

      // Search for the NEW direction — should match d1
      const nearNew = await adapter.vectorSearch(basis(DIMS_512, 5), {
        filter: {},
        controls: { $limit: 1 },
      } as any);
      expect((nearNew[0] as any).id).toBe("d1");
      const distNew = (nearNew[0] as any)._distance as number;

      // Search for the OLD direction — the same row should now be far away
      const nearOld = await adapter.vectorSearch(basis(DIMS_512, 0), {
        filter: {},
        controls: { $limit: 1 },
      } as any);
      const distOld = (nearOld[0] as any)._distance as number;
      expect(distOld).toBeGreaterThan(distNew);
    });

    it("deletes row → vec0 row disappears", async () => {
      const { insertedId } = await table.insertOne({
        id: "d1",
        title: "Doc",
        embedding: basis(DIMS_512, 0),
      } as any);

      const mainRow = driver.get<{ rowid: number }>(`SELECT rowid FROM "documents" WHERE id = ?`, [
        insertedId,
      ]);
      expect(mainRow).not.toBeNull();

      await table.deleteMany({ id: "d1" } as any);

      const shadowRow = driver.get<{ rowid: number }>(
        `SELECT rowid FROM "documents__vec__embedding" WHERE rowid = ?`,
        [mainRow!.rowid],
      );
      expect(shadowRow).toBeNull();
    });

    it("recreateTable rebuilds shadow table from main rows", async () => {
      await table.insertOne({
        id: "a",
        title: "Alpha",
        embedding: basis(DIMS_512, 0),
      } as any);
      await table.insertOne({
        id: "b",
        title: "Beta",
        embedding: basis(DIMS_512, 1),
      } as any);

      const before = driver.get<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM "documents__vec__embedding"`,
      );
      expect(before!.cnt).toBe(2);

      await adapter.recreateTable();
      await table.syncIndexes();

      const after = driver.get<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM "documents__vec__embedding"`,
      );
      expect(after!.cnt).toBe(2);

      // Sanity check: nearest neighbour still resolves
      const results = await adapter.vectorSearch(basis(DIMS_512, 0), {
        filter: {},
        controls: { $limit: 1 },
      } as any);
      expect(results).toHaveLength(1);
      expect((results[0] as any).id).toBe("a");
    });
  });

  // ── vectorSearch behaviour ────────────────────────────────────────────────

  describe("vectorSearch", () => {
    let adapter: SqliteAdapter;
    let table: AtscriptDbTable;

    beforeEach(async () => {
      ({ driver, adapter, table } = makeTable(DocumentType));
      await table.ensureTable();
      await table.syncIndexes();
    });

    /** Seeds four documents with known unit-length vectors. */
    async function seedDocuments() {
      await table.insertMany([
        { id: "v0", title: "near 0", embedding: basis(DIMS_512, 0) },
        { id: "v1", title: "orth 1", embedding: basis(DIMS_512, 1) },
        {
          id: "v01",
          title: "between 0 and 1",
          embedding: normalize(sparseVec(DIMS_512, { 0: 0.7, 1: 0.7 })),
        },
        {
          id: "vneg0",
          title: "opposite of 0",
          embedding: normalize(sparseVec(DIMS_512, { 0: -1 })),
        },
      ] as any);
    }

    it("returns rows ordered by cosine distance", async () => {
      await seedDocuments();
      const results = await adapter.vectorSearch(basis(DIMS_512, 0), {
        filter: {},
        controls: { $limit: 4 },
      } as any);
      expect(results).toHaveLength(4);

      // Ascending order by _distance
      const distances = results.map((r) => (r as any)._distance as number);
      for (let i = 1; i < distances.length; i++) {
        expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
      }

      // Closest is the exact-match basis vector
      expect((results[0] as any).id).toBe("v0");
      // Furthest is the opposite vector
      expect((results[results.length - 1] as any).id).toBe("vneg0");
    });

    it("respects $limit and $skip", async () => {
      await seedDocuments();
      const results = await adapter.vectorSearch(basis(DIMS_512, 0), {
        filter: {},
        controls: { $limit: 2, $skip: 1 },
      } as any);
      expect(results).toHaveLength(2);

      const all = await adapter.vectorSearch(basis(DIMS_512, 0), {
        filter: {},
        controls: { $limit: 4 },
      } as any);
      // Skipping 1 → matches positions 1 and 2 of the full list
      expect((results[0] as any).id).toBe((all[1] as any).id);
      expect((results[1] as any).id).toBe((all[2] as any).id);
    });

    it("respects $threshold from controls", async () => {
      await seedDocuments();

      // Very strict similarity threshold — only near-exact matches survive.
      // cosine threshold 0.9 → distance ≤ 2*(1-0.9) = 0.2
      const strict = await adapter.vectorSearch(basis(DIMS_512, 0), {
        filter: {},
        controls: { $limit: 10, $threshold: 0.9 },
      } as any);
      expect(strict.length).toBeGreaterThanOrEqual(1);
      for (const r of strict) {
        expect((r as any)._distance as number).toBeLessThanOrEqual(0.2 + 1e-6);
      }
      const strictIds = strict.map((r) => (r as any).id);
      expect(strictIds).toContain("v0");
      expect(strictIds).not.toContain("vneg0");

      // Threshold 0 → distance ≤ 2*(1-0) = 2, which is the full cosine range
      const all = await adapter.vectorSearch(basis(DIMS_512, 0), {
        filter: {},
        controls: { $limit: 10, $threshold: 0 },
      } as any);
      expect(all).toHaveLength(4);
    });

    it("uses schema-level @db.search.vector.threshold when no $threshold given", async () => {
      driver.close();
      ({ driver, adapter, table } = makeTable(ArticleType));
      await table.ensureTable();
      await table.syncIndexes();

      // schema threshold is 0.5 → distance ≤ 2*(1-0.5) = 1.0 → drops vneg0
      // (distance ≈ 2 vs basis 0).
      await table.insertMany([
        {
          id: "a",
          category: "x",
          status: "active",
          score: 1,
          embedding: basis(DIMS_512, 0),
        },
        {
          id: "b",
          category: "x",
          status: "active",
          score: 2,
          embedding: normalize(sparseVec(DIMS_512, { 0: 0.7, 1: 0.7 })),
        },
        {
          id: "c",
          category: "x",
          status: "active",
          score: 3,
          embedding: normalize(sparseVec(DIMS_512, { 0: -1 })),
        },
      ] as any);

      const results = await adapter.vectorSearch(basis(DIMS_512, 0), {
        filter: {},
        controls: { $limit: 10 },
      } as any);

      const ids = results.map((r) => (r as any).id);
      expect(ids).toContain("a");
      expect(ids).not.toContain("c");
    });

    it("query-time $threshold overrides schema threshold", async () => {
      driver.close();
      ({ driver, adapter, table } = makeTable(ArticleType));
      await table.ensureTable();
      await table.syncIndexes();

      await table.insertMany([
        {
          id: "a",
          category: "x",
          status: "active",
          score: 1,
          embedding: basis(DIMS_512, 0),
        },
        {
          id: "c",
          category: "x",
          status: "active",
          score: 3,
          embedding: normalize(sparseVec(DIMS_512, { 0: -1 })),
        },
      ] as any);

      // $threshold: 0 should override schema's 0.5 and return everything
      const results = await adapter.vectorSearch(basis(DIMS_512, 0), {
        filter: {},
        controls: { $limit: 10, $threshold: 0 },
      } as any);
      expect(results).toHaveLength(2);
    });

    it("partition push-down: filtering by partition field narrows KNN", async () => {
      driver.close();
      ({ driver, adapter, table } = makeTable(ArticleType));
      await table.ensureTable();
      await table.syncIndexes();

      await table.insertMany([
        {
          id: "tech-a",
          category: "tech",
          status: "active",
          score: 1,
          embedding: basis(DIMS_512, 0),
        },
        {
          id: "tech-b",
          category: "tech",
          status: "active",
          score: 2,
          embedding: basis(DIMS_512, 1),
        },
        {
          id: "food-a",
          category: "food",
          status: "active",
          score: 3,
          embedding: basis(DIMS_512, 0),
        },
      ] as any);

      const results = await adapter.vectorSearch(basis(DIMS_512, 0), {
        filter: { category: "tech" },
        controls: { $limit: 10, $threshold: 0 },
      } as any);
      const ids = results.map((r) => (r as any).id);
      expect(ids).toContain("tech-a");
      expect(ids).toContain("tech-b");
      expect(ids).not.toContain("food-a");
    });

    it("residual filter applies after KNN", async () => {
      driver.close();
      ({ driver, adapter, table } = makeTable(ArticleType));
      await table.ensureTable();
      await table.syncIndexes();

      await table.insertMany([
        {
          id: "a",
          category: "x",
          status: "active",
          score: 1,
          embedding: basis(DIMS_512, 0),
        },
        {
          id: "b",
          category: "x",
          status: "active",
          score: 5,
          embedding: normalize(sparseVec(DIMS_512, { 0: 0.9, 1: 0.1 })),
        },
        {
          id: "c",
          category: "x",
          status: "active",
          score: 10,
          embedding: normalize(sparseVec(DIMS_512, { 0: 0.8, 1: 0.2 })),
        },
      ] as any);

      // `score` is NOT declared as @db.search.filter — must be a residual filter
      const results = await adapter.vectorSearch(basis(DIMS_512, 0), {
        filter: { score: { $gte: 5 } },
        controls: { $limit: 10, $threshold: 0 },
      } as any);
      const ids = results.map((r) => (r as any).id);
      expect(ids).not.toContain("a");
      expect(ids).toContain("b");
      expect(ids).toContain("c");
    });

    it("rejects vector with wrong dimensions", async () => {
      await expect(
        adapter.vectorSearch([1, 0, 0], { filter: {}, controls: {} } as any),
      ).rejects.toThrow(/Vector dimension mismatch/);
    });

    it("rejects when no vector fields defined", async () => {
      driver.close();
      const drv = new BetterSqlite3Driver(":memory:", { vector: true });
      const ad = new SqliteAdapter(drv);
      const t = new AtscriptDbTable(NoVectorType, ad);
      await t.ensureTable();
      await t.syncIndexes();
      driver = drv;
      await expect(
        ad.vectorSearch([1, 0, 0, 0], { filter: {}, controls: {} } as any),
      ).rejects.toThrow(/No vector fields/);
    });

    it("rejects unknown indexName", async () => {
      await expect(
        adapter.vectorSearch(
          basis(DIMS_512, 0),
          { filter: {}, controls: {} } as any,
          "nonexistent",
        ),
      ).rejects.toThrow(/Vector index "nonexistent" not found/);
    });

    it("respects @db.column custom physical column name", async () => {
      driver.close();
      const drv = new BetterSqlite3Driver(":memory:", { vector: true });
      const ad = new SqliteAdapter(drv);
      const t = new AtscriptDbTable(RenamedDocType, ad);
      await t.ensureTable();
      await t.syncIndexes();
      driver = drv;

      // Main table should have the renamed physical column
      const cols = drv.all<{ name: string; type: string }>(`PRAGMA table_info("renamed_docs")`);
      const physical = cols.find((c) => c.name === "emb_vec");
      expect(physical).toBeDefined();
      expect(physical!.type).toBe("BLOB");

      // Insert via the logical name — descriptor renaming is the table layer's job
      await t.insertOne({
        id: "r1",
        embedding: basis(DIMS_512, 0),
      } as any);
      await t.insertOne({
        id: "r2",
        embedding: basis(DIMS_512, 1),
      } as any);

      const results = await ad.vectorSearch(basis(DIMS_512, 0), {
        filter: {},
        controls: { $limit: 1 },
      } as any);
      expect(results).toHaveLength(1);
      expect((results[0] as any).id).toBe("r1");
    });
  });

  // ── vectorSearchWithCount ────────────────────────────────────────────────

  describe("vectorSearchWithCount", () => {
    let adapter: SqliteAdapter;
    let table: AtscriptDbTable;

    beforeEach(async () => {
      ({ driver, adapter, table } = makeTable(DocumentType));
      await table.ensureTable();
      await table.syncIndexes();

      await table.insertMany([
        { id: "v0", title: "0", embedding: basis(DIMS_512, 0) },
        { id: "v1", title: "1", embedding: basis(DIMS_512, 1) },
        { id: "v2", title: "2", embedding: basis(DIMS_512, 2) },
      ] as any);
    });

    it("returns count alongside data with $limit greater than N (exact)", async () => {
      const result = await adapter.vectorSearchWithCount(basis(DIMS_512, 0), {
        filter: {},
        controls: { $limit: 10 },
      } as any);
      expect(result.data).toHaveLength(3);
      expect(result.count).toBe(3);
    });

    it("count >= data.length when $limit < N", async () => {
      const result = await adapter.vectorSearchWithCount(basis(DIMS_512, 0), {
        filter: {},
        controls: { $limit: 2 },
      } as any);
      expect(result.data).toHaveLength(2);
      expect(result.count).toBeGreaterThanOrEqual(result.data.length);
    });
  });

  // ── Euclidean (l2) ───────────────────────────────────────────────────────

  describe("euclidean (l2)", () => {
    let adapter: SqliteAdapter;
    let table: AtscriptDbTable;

    beforeEach(async () => {
      ({ driver, adapter, table } = makeTable(PointType));
      await table.ensureTable();
      await table.syncIndexes();
    });

    /** Builds a 512-d vector with `value` placed at `idx` (no normalisation). */
    function point(idx: number, value: number): number[] {
      return sparseVec(DIMS_512, { [idx]: value });
    }

    it("orders by euclidean distance", async () => {
      await table.insertMany([
        { id: "origin", embedding: sparseVec(DIMS_512, {}) },
        { id: "near", embedding: point(0, 0.5) },
        { id: "far", embedding: point(0, 10) },
      ] as any);

      const results = await adapter.vectorSearch(sparseVec(DIMS_512, {}), {
        filter: {},
        controls: { $limit: 3 },
      } as any);
      expect((results[0] as any).id).toBe("origin");
      expect((results[1] as any).id).toBe("near");
      expect((results[2] as any).id).toBe("far");

      const distances = results.map((r) => (r as any)._distance as number);
      expect(distances[0]).toBeLessThan(distances[1]);
      expect(distances[1]).toBeLessThan(distances[2]);
    });

    it("treats threshold as raw distance ceiling for non-cosine", async () => {
      await table.insertMany([
        { id: "origin", embedding: sparseVec(DIMS_512, {}) },
        { id: "near", embedding: point(0, 0.5) },
        { id: "far", embedding: point(0, 10) },
      ] as any);

      // threshold 1.0 → euclidean distance ≤ 1.0
      const results = await adapter.vectorSearch(sparseVec(DIMS_512, {}), {
        filter: {},
        controls: { $limit: 10, $threshold: 1.0 },
      } as any);
      const ids = results.map((r) => (r as any).id);
      expect(ids).toContain("origin");
      expect(ids).toContain("near");
      expect(ids).not.toContain("far");

      for (const r of results) {
        expect((r as any)._distance as number).toBeLessThanOrEqual(1.0 + 1e-6);
      }
    });

    it("vec0 DDL declares l2 distance metric", () => {
      const row = driver.get<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
        ["points__vec__embedding"],
      );
      expect(row).not.toBeNull();
      expect(row!.sql).toContain("distance_metric=l2");
      expect(row!.sql).toContain("embedding float[512]");
    });
  });
});

// ── Fallback suite (always runs) ────────────────────────────────────────────

describe("SqliteAdapter vector search — graceful fallback (no sqlite-vec)", () => {
  let driver: BetterSqlite3Driver;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/vector-table.as");
    DocumentType = fixtures.Document;
  });

  afterEach(() => {
    try {
      driver?.close();
    } catch {
      // already closed
    }
  });

  it("typeMapper falls back to TEXT for vec fields when extension unavailable", async () => {
    // Construct driver WITHOUT { vector: true } — hasVectorExt is false.
    driver = new BetterSqlite3Driver(":memory:");
    const adapter = new SqliteAdapter(driver);
    const table = new AtscriptDbTable(DocumentType, adapter);

    // sync should succeed even without sqlite-vec
    await table.ensureTable();
    await table.syncIndexes();

    const cols = driver.all<{ name: string; type: string }>(`PRAGMA table_info("documents")`);
    const emb = cols.find((c) => c.name === "embedding");
    expect(emb).toBeDefined();
    expect(emb!.type).toBe("TEXT");
  });

  it("vectorSearch throws actionable error when extension unavailable", async () => {
    driver = new BetterSqlite3Driver(":memory:");
    const adapter = new SqliteAdapter(driver);
    const table = new AtscriptDbTable(DocumentType, adapter);
    await table.ensureTable();
    await table.syncIndexes();

    await expect(
      adapter.vectorSearch(basis(DIMS_512, 0), { filter: {}, controls: {} } as any),
    ).rejects.toThrow(/sqlite-vec/);
  });

  it("no shadow table created when extension unavailable", async () => {
    driver = new BetterSqlite3Driver(":memory:");
    const adapter = new SqliteAdapter(driver);
    const table = new AtscriptDbTable(DocumentType, adapter);
    await table.ensureTable();
    await table.syncIndexes();

    const rows = driver.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%__vec__%'`,
    );
    expect(rows).toHaveLength(0);
  });
});
