import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import type { SqliteAdapterOptions } from "../tx-gate";
import { expectLockTimeout, prepareFixtures } from "./test-utils";

// FTS5 / vec0 shadow tables are created (virtual table, three sync triggers,
// a rebuild / seed insert) and dropped (triggers, table) as one unit since
// 0.1.178. Before, a statement failing in the middle left the virtual table
// without its triggers; the next sync saw the table, found its columns
// matching and kept it — the index silently stopped following writes.

let sqliteVecAvailable = true;
try {
  new BetterSqlite3Driver(":memory:", { vector: true }).close();
} catch {
  sqliteVecAvailable = false;
}

let fx: { Article: any; FtoPlain: any; Document: any };
let driver: BetterSqlite3Driver;
let dir: string | undefined;

beforeAll(async () => {
  await prepareFixtures();
  const { Article } = await import("./fixtures/fts-article.as");
  const { FtoPlain } = await import("./fixtures/fulltext-options.as");
  const { Document } = await import("./fixtures/vector-table.as");
  fx = { Article, FtoPlain, Document };
});

afterEach(() => {
  driver?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A database file in a fresh temp directory (removed after the test). */
function tempFile(): string {
  dir = mkdtempSync(join(tmpdir(), "asdb-units-"));
  return join(dir, "db.sqlite");
}

/** The better-sqlite3 connection behind a driver. */
const raw = (d: BetterSqlite3Driver) =>
  (d as unknown as { db: import("better-sqlite3").Database }).db;

/** Runs `action` (once) before the driver's next `exec` whose SQL `match`es — a throw skips the statement. */
function beforeExec(match: (sql: string) => boolean, action: (sql: string) => void): void {
  const exec = driver.exec.bind(driver);
  driver.exec = (sql: string) => {
    if (match(sql)) {
      delete (driver as { exec?: unknown }).exec; // back to the prototype's
      action(sql);
    }
    exec(sql);
  };
}

/**
 * Makes the driver's next `exec` whose SQL `match`es throw (once) instead of
 * running; the fields of `failure` go on the error (e.g. a busy `code`).
 */
function failOnce(match: (sql: string) => boolean, failure: Record<string, unknown> = {}): void {
  beforeExec(match, (sql) => {
    throw Object.assign(new Error(`injected failure: ${sql.slice(0, 60)}`), failure);
  });
}

/** The failure cases of a unit's three `CREATE TRIGGER` statements for `table`. */
const createTriggerCases = (table: string): Array<[string, (sql: string) => boolean]> =>
  ["ai", "ad", "au"].map((t) => [
    `CREATE TRIGGER __${t}`,
    (sql) => sql.startsWith("CREATE TRIGGER") && sql.includes(`${table}__${t}"`),
  ]);

/** The three sync triggers of `table`, as {@link objects} lists them. */
const allTriggers = (table: string) => ["ad", "ai", "au"].map((t) => `trigger:${table}__${t}`);

/** The `sqlite_master` objects (tables, triggers) whose name starts with `prefix`. */
const objects = (prefix: string) =>
  driver
    .all<{ type: string; name: string }>(
      `SELECT type, name FROM sqlite_master WHERE name LIKE ? ORDER BY name`,
      [`${prefix}%`],
    )
    .map((r) => `${r.type}:${r.name}`);

const triggersOf = (prefix: string) => objects(prefix).filter((o) => o.startsWith("trigger:"));
const inTransaction = () => raw(driver).inTransaction;
const ids = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => r.id).toSorted((a, b) => Number(a) - Number(b));

function tableOf(type: unknown, options?: SqliteAdapterOptions) {
  const adapter = new SqliteAdapter(driver, options);
  return { adapter, table: new AtscriptDbTable(type as any, adapter) as any };
}

describe("[sqlite] FTS5 add: all or nothing", () => {
  const FTS = "articles__fts__articles_ft";
  const later: Array<[string, (sql: string) => boolean]> = [
    ...createTriggerCases(FTS),
    ["the 'rebuild' insert", (sql) => sql.includes("VALUES ('rebuild')")],
  ];

  async function setup() {
    driver = new BetterSqlite3Driver(":memory:");
    const { table } = tableOf(fx.Article);
    await table.ensureTable();
    // a row from before the index: only the 'rebuild' insert indexes it
    await table.insertOne({ title: "Quokka island", body: "a marsupial", category: "x" });
    return table;
  }

  /** (c) a following sync builds the complete index: old rows and new writes are found. */
  async function expectCompleteAfterSync(table: any) {
    await table.syncIndexes();
    expect(triggersOf(FTS)).toEqual(allTriggers(FTS));
    await table.insertOne({ title: "Wombat burrow", body: "another marsupial", category: "x" });
    expect(ids(await table.search("quokka", {}))).toEqual([1]);
    expect(ids(await table.search("wombat", {}))).toEqual([2]);
    expect(ids(await table.search("marsupial", {}))).toEqual([1, 2]);
  }

  it.each(later)("a failing %s leaves no FTS table and no trigger", async (_, match) => {
    const table = await setup();
    failOnce(match);
    await expect(table.syncIndexes()).rejects.toThrow("injected failure");
    expect(objects(FTS)).toEqual([]);
    expect(inTransaction()).toBe(false);
    await expectCompleteAfterSync(table);
  });

  it("a busy statement in the middle is still the retryable LOCK_TIMEOUT, nothing left", async () => {
    const table = await setup();
    failOnce(later[1]![1], { code: "SQLITE_BUSY", message: "database is locked" });
    const error = await table.syncIndexes().catch((e: unknown) => e);
    expectLockTimeout(error, { code: "SQLITE_BUSY" });
    expect(objects(FTS)).toEqual([]);
    await expectCompleteAfterSync(table);
  });

  // A real COMMIT refused by another connection's read (rollback-journal
  // mode, better-sqlite3's default). With a SAVEPOINT as the unit's own
  // transaction, the cleanup's RELEASE committed again, met the same lock and
  // left the transaction open: later autocommit writes ran inside it and were
  // lost on close. The unit now opens BEGIN IMMEDIATE and ends with ROLLBACK.
  it("a COMMIT refused by a reader: LOCK_TIMEOUT, no transaction left, later writes kept", async () => {
    const file = tempFile();
    driver = new BetterSqlite3Driver(file, { timeout: 50 } as never);
    const { adapter, table } = tableOf(fx.Article);
    await table.ensureTable();
    await table.insertOne({ title: "Quokka island", body: "a marsupial", category: "x" });
    const reader = new BetterSqlite3Driver(file);
    try {
      raw(reader).exec("BEGIN");
      raw(reader).prepare("SELECT count(*) FROM articles").get(); // holds SHARED
      expectLockTimeout(await table.syncIndexes().catch((e: unknown) => e), {
        code: "SQLITE_BUSY",
      });
      raw(reader).exec("COMMIT");
    } finally {
      reader.close();
    }
    expect(inTransaction()).toBe(false);
    expect(objects(FTS)).toEqual([]);

    await table.insertOne({ title: "Wombat burrow", body: "x", category: "x" }); // autocommit
    await adapter.withTransaction(() =>
      table.insertOne({ title: "Numbat", body: "termites", category: "x" }),
    );
    await table.syncIndexes();
    expect(triggersOf(FTS)).toEqual(allTriggers(FTS));
    expect(ids(await table.search("wombat", {}))).toEqual([2]);
    driver.close();
    driver = new BetterSqlite3Driver(file);
    expect(driver.get(`SELECT count(*) AS n FROM articles`)).toEqual({ n: 3 });
  });

  // WAL: a deferred unit whose first statement only reads (DROP TRIGGER IF
  // EXISTS of a missing trigger) pinned a snapshot; a commit by another
  // connection before its first write made that write fail at once with
  // SQLITE_BUSY_SNAPSHOT (no busy wait), where the autocommit statements
  // before 0.1.178 succeeded. BEGIN IMMEDIATE takes the write lock first.
  it("WAL: another connection's commit mid-drop cannot fail the drop", async () => {
    const file = tempFile();
    driver = new BetterSqlite3Driver(file, { timeout: 2000 } as never);
    driver.exec("PRAGMA journal_mode = WAL");
    const { adapter, table } = tableOf(fx.Article);
    await table.ensureTable();
    await table.syncIndexes();
    for (const t of ["ai", "ad", "au"]) driver.exec(`DROP TRIGGER "${FTS}__${t}"`);
    const other = new BetterSqlite3Driver(file, { timeout: 10 } as never);
    let otherWrite: unknown = "not attempted";
    beforeExec(
      (sql) => sql === `DROP TABLE IF EXISTS "${FTS}"`,
      () => {
        try {
          other.run(`INSERT INTO articles (title, body, category) VALUES ('o', 'o', 'o')`);
          otherWrite = "committed";
        } catch (error) {
          otherWrite = error;
        }
      },
    );
    try {
      // drops the FTS table over `title` (its triggers are gone already)
      await adapter.dropIndexesForColumns(["title"]);
      expect(objects(FTS)).toEqual([]);
      // the unit held the write lock: the other connection waited (on one
      // thread its wait cannot end, so it gave up) instead of slipping in
      expect(otherWrite).toMatchObject({ code: "SQLITE_BUSY" });
      expect(inTransaction()).toBe(false);
      other.run(`INSERT INTO articles (title, body, category) VALUES ('o', 'o', 'o')`);
      expect(await table.count({ filter: {}, controls: {} })).toBe(1);
    } finally {
      other.close();
    }
  });

  it("inside an open transaction only the unit rolls back; the transaction goes on", async () => {
    const table = await setup();
    const adapter = table.dbAdapter as SqliteAdapter;
    await adapter.withTransaction(async () => {
      failOnce(later[2]![1]);
      await expect(table.syncIndexes()).rejects.toThrow("injected failure");
      expect(objects(FTS)).toEqual([]);
      expect(inTransaction()).toBe(true);
      await table.insertOne({ title: "Numbat", body: "termites", category: "y" });
    });
    expect(await table.count({ filter: {}, controls: {} })).toBe(2);
    await table.syncIndexes();
    expect(ids(await table.search("numbat", {}))).toEqual([2]);
  });
});

describe("[sqlite] FTS5 rebuild: a failure keeps the old index", () => {
  const FTS = "fto_plain__fts__ft_body";
  // Every statement of the rebuild after its first (DROP TRIGGER __ai)
  const later: Array<[string, (sql: string) => boolean]> = [
    ["DROP TRIGGER __ad", (sql) => sql === `DROP TRIGGER IF EXISTS "${FTS}__ad"`],
    ["DROP TRIGGER __au", (sql) => sql === `DROP TRIGGER IF EXISTS "${FTS}__au"`],
    ["DROP TABLE", (sql) => sql === `DROP TABLE IF EXISTS "${FTS}"`],
    [
      "CREATE VIRTUAL TABLE",
      (sql) => sql.startsWith(`CREATE VIRTUAL TABLE IF NOT EXISTS "${FTS}"`),
    ],
    ...createTriggerCases(FTS),
    ["the 'rebuild' insert", (sql) => sql.includes("VALUES ('rebuild')")],
  ];
  const ftsSql = () =>
    driver.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = ?`, [FTS])?.sql;

  it.each(later)(
    "a failing %s: the old table and its triggers stay and index new rows",
    async (_, match) => {
      driver = new BetterSqlite3Driver(":memory:");
      const old = tableOf(fx.FtoPlain).table;
      await old.ensureTable();
      await old.syncIndexes();
      await old.insertOne({ id: 1, body: "quokka island" });
      const oldSql = ftsSql();
      expect(oldSql).not.toContain("prefix");

      // `ftsPrefix` changed: the sync rebuilds the FTS5 table
      const next = tableOf(fx.FtoPlain, { ftsPrefix: [2, 3] }).table;
      failOnce(match);
      await expect(next.syncIndexes()).rejects.toThrow("injected failure");
      expect(ftsSql()).toBe(oldSql);
      expect(triggersOf(FTS)).toEqual(allTriggers(FTS));
      expect(inTransaction()).toBe(false);
      await old.insertOne({ id: 2, body: "wombat burrow" });
      expect(ids(await old.search("wombat", {}))).toEqual([2]);
      expect(ids(await old.search("quokka", {}))).toEqual([1]);

      // (c) the next sync rebuilds it completely
      await next.syncIndexes();
      expect(ftsSql()).toContain("prefix='2 3'");
      expect(triggersOf(FTS)).toEqual(allTriggers(FTS));
      await next.insertOne({ id: 3, body: "numbat termites" });
      expect(ids(await next.search("quokka", {}))).toEqual([1]);
      expect(ids(await next.search("wom*", {}))).toEqual([2]);
      expect(ids(await next.search("numbat", {}))).toEqual([3]);
    },
  );
});

const vecDescribe = sqliteVecAvailable ? describe : describe.skip;

/** A 512-d unit vector along dimension `i`. */
const basis = (i: number) => Array.from({ length: 512 }, (_, k) => (k === i ? 1 : 0));

vecDescribe("[sqlite] vec0 add: all or nothing (real sqlite-vec)", () => {
  const VEC = "documents__vec__embedding";
  const later: Array<[string, (sql: string) => boolean]> = [
    ...createTriggerCases(VEC),
    ["the seed insert", (sql) => sql.startsWith(`INSERT INTO "${VEC}"`)],
  ];
  it.each(later)("a failing %s leaves no vec0 table and no trigger", async (_, match) => {
    driver = new BetterSqlite3Driver(":memory:", { vector: true });
    const { adapter, table } = tableOf(fx.Document);
    await table.ensureTable();
    // a row from before the index: only the seed insert indexes it
    await table.insertOne({ id: "d0", title: "old", embedding: basis(0) });

    failOnce(match);
    await expect(table.syncIndexes()).rejects.toThrow("injected failure");
    expect(objects(VEC)).toEqual([]);
    expect(inTransaction()).toBe(false);

    // (c) the next sync creates the complete index: the seeded row and new writes are found
    await table.syncIndexes();
    expect(triggersOf(VEC)).toEqual(allTriggers(VEC));
    await table.insertOne({ id: "d1", title: "new", embedding: basis(1) });
    const near = async (i: number) =>
      (await adapter.vectorSearch(basis(i), { filter: {}, controls: { $limit: 1 } } as any)).map(
        (r: any) => r.id,
      );
    expect(await near(0)).toEqual(["d0"]);
    expect(await near(1)).toEqual(["d1"]);
  });

  it("a failing DROP TABLE after the triggers are dropped keeps the vec0 table and its triggers", async () => {
    driver = new BetterSqlite3Driver(":memory:", { vector: true });
    const { adapter, table } = tableOf(fx.Document);
    await table.ensureTable();
    await table.syncIndexes();
    await table.insertOne({ id: "d0", title: "old", embedding: basis(0) });
    const before = objects(VEC);

    failOnce((sql) => sql === `DROP TABLE IF EXISTS "${VEC}"`);
    await expect(adapter.dropTable()).rejects.toThrow("injected failure");
    expect(objects(VEC)).toEqual(before);
    expect(triggersOf(VEC)).toEqual(allTriggers(VEC));
    expect(inTransaction()).toBe(false);
    // the index still follows writes
    await table.insertOne({ id: "d1", title: "new", embedding: basis(1) });
    const near = await adapter.vectorSearch(basis(1), {
      filter: {},
      controls: { $limit: 1 },
    } as any);
    expect(near.map((r: any) => r.id)).toEqual(["d1"]);
  });
});
