import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { DbError, DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures, RecordingDriver } from "./test-utils";

// Since 0.1.151: the better-sqlite3 driver reuses prepared statements (bounded
// LRU), the adapter reuses INSERT text per column signature, and a single-row
// write without guard / check / nested data runs without a wrapping
// transaction.

let ProfileTable: any;
let UsersTable: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ ProfileTable, UsersTable } = await import("./fixtures/test-table.as"));
});

/** The driver's private statement cache (size only — for bound checks). */
function cacheSize(driver: BetterSqlite3Driver): number {
  return (driver as unknown as { _stmts: Map<string, unknown> })._stmts.size;
}

describe("BetterSqlite3Driver statement cache", () => {
  it("reuses one prepared statement per SQL text", () => {
    const driver = new BetterSqlite3Driver(":memory:");
    const db = (driver as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    let prepares = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      prepares++;
      return prepare(sql);
    };
    driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)");
    prepares = 0;
    for (let i = 1; i <= 5; i++) driver.run("INSERT INTO t (id, a) VALUES (?, ?)", [i, `a${i}`]);
    for (let i = 1; i <= 5; i++) driver.get("SELECT * FROM t WHERE id = ?", [i]);
    expect(driver.all("SELECT * FROM t WHERE id > ?", [3])).toHaveLength(2);
    expect(prepares).toBe(3);
    driver.close();
  });

  it("is bounded (least-recently-used evicted) — varying `IN` lengths cannot grow it", () => {
    const driver = new BetterSqlite3Driver(":memory:", { statementCacheSize: 4 });
    driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    for (let n = 1; n <= 20; n++) {
      const ids = Array.from({ length: n }, (_, i) => i);
      driver.all(`SELECT * FROM t WHERE id IN (${ids.map(() => "?").join(", ")})`, ids);
      expect(cacheSize(driver)).toBeLessThanOrEqual(4);
    }
    driver.close();
  });

  it("statementCacheSize: 0 disables the cache", () => {
    const driver = new BetterSqlite3Driver(":memory:", { statementCacheSize: 0 });
    driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    driver.get("SELECT * FROM t WHERE id = ?", [1]);
    expect(cacheSize(driver)).toBe(0);
    driver.close();
  });

  it("stays correct across schema changes (cached statements re-prepare)", () => {
    const driver = new BetterSqlite3Driver(":memory:");
    driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)");
    driver.run("INSERT INTO t (id, a) VALUES (?, ?)", [1, "x"]);
    const sel = "SELECT * FROM t WHERE id = ?";
    expect(driver.get(sel, [1])).toEqual({ id: 1, a: "x" });
    // DDL through `run` (not `exec`): the cached statement survives and SQLite
    // re-prepares it against the new schema.
    driver.run("ALTER TABLE t ADD COLUMN b INTEGER DEFAULT 7");
    expect(driver.get(sel, [1])).toEqual({ id: 1, a: "x", b: 7 });
    driver.exec("DROP TABLE t");
    driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, z TEXT)");
    driver.run("INSERT INTO t (id, z) VALUES (?, ?)", [1, "q"]);
    expect(driver.get(sel, [1])).toEqual({ id: 1, z: "q" });
    // A statement over a dropped table fails like a fresh prepare would.
    driver.get(sel, [1]);
    driver.run("DROP TABLE t");
    expect(() => driver.get(sel, [1])).toThrow(/no such table: t/);
    driver.close();
  });

  it("never caches PRAGMA statements (schema introspection stays fresh)", () => {
    const driver = new BetterSqlite3Driver(":memory:");
    driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect(driver.all('PRAGMA table_info("t")')).toHaveLength(1);
    driver.run("ALTER TABLE t ADD COLUMN b TEXT");
    expect(driver.all('PRAGMA table_info("t")')).toHaveLength(2);
    const cached = [...(driver as unknown as { _stmts: Map<string, unknown> })._stmts.keys()];
    expect(cached.some((sql) => sql.startsWith("PRAGMA"))).toBe(false);
    driver.close();
  });

  it("runs BEGIN / COMMIT / ROLLBACK through statements prepared once", () => {
    const driver = new BetterSqlite3Driver(":memory:");
    driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    for (let i = 1; i <= 3; i++) {
      driver.exec("BEGIN IMMEDIATE");
      driver.run("INSERT INTO t (id) VALUES (?)", [i]);
      driver.exec(i === 2 ? "ROLLBACK" : "COMMIT");
    }
    expect(driver.all("SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }, { id: 3 }]);
    expect(() => driver.exec("COMMIT")).toThrow(/no transaction is active/);
    const cached = (driver as unknown as { _stmts: Map<string, unknown> })._stmts;
    for (const sql of ["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]) expect(cached.has(sql)).toBe(true);
    driver.close();
    expect(cacheSize(driver)).toBe(0);
  });

  it("BEGIN IMMEDIATE locks a database attached after it was first prepared", () => {
    const dir = mkdtempSync(join(tmpdir(), "asdb-attach-"));
    const driver = new BetterSqlite3Driver(join(dir, "main.db"), { timeout: 0 });
    const other = new BetterSqlite3Driver(join(dir, "aux.db"), { timeout: 0 });
    try {
      other.exec("CREATE TABLE w (a)");
      driver.exec("BEGIN IMMEDIATE"); // prepared (and cached) before the ATTACH
      driver.exec("COMMIT");
      driver.exec(`ATTACH DATABASE '${join(dir, "aux.db")}' AS aux`);
      driver.exec("BEGIN IMMEDIATE");
      expect(() => other.run("INSERT INTO w VALUES (1)")).toThrow(/locked|busy/i);
      driver.exec("COMMIT");
    } finally {
      driver.close();
      other.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function profile(id: number) {
  return {
    id,
    name: `p${id}`,
    contact: { email: `p${id}@x.io` },
    preferences: { theme: "dark", lang: "en" },
    tags: ["a"],
    settings: { notifications: { email: true, sms: false } },
  };
}

describe("single-statement writes skip the wrapping transaction", () => {
  let driver: RecordingDriver;
  let profiles: any;
  let users: any;

  beforeEach(async () => {
    driver = new RecordingDriver(new BetterSqlite3Driver(":memory:"));
    const space = new DbSpace(() => new SqliteAdapter(driver));
    profiles = space.getTable(ProfileTable);
    users = space.getTable(UsersTable);
    await profiles.ensureTable();
    await users.ensureTable();
    driver.execs.length = 0;
  });

  const begins = () => driver.execs.filter((sql) => sql.startsWith("BEGIN")).length;

  it("insertOne / replaceOne / updateOne / deleteOne of one row open no transaction", async () => {
    await profiles.insertOne(profile(1));
    await profiles.replaceOne({ ...profile(1), name: "r" });
    await profiles.updateOne({ id: 1, name: "u" });
    await profiles.updateOne({ id: 1 }); // empty patch → one count
    await profiles.deleteOne(1);
    expect(begins()).toBe(0);
  });

  it("batches, guards, checks and array-operator patches keep their transaction", async () => {
    await profiles.insertMany([profile(1), profile(2)]);
    expect(begins()).toBe(1);
    await profiles.insertOne(profile(3), { guard: () => {} });
    expect(begins()).toBe(2);
    await profiles.updateOne({ id: 3, name: "c" }, { check: () => {} });
    expect(begins()).toBe(3);
    // `$insert` is a read-modify-write pair → its own transaction.
    await profiles.updateOne({ id: 3, tags: { $insert: ["b"] } });
    expect(begins()).toBe(4);
    expect((await profiles.findById(3)).tags).toEqual(["a", "b"]);
  });

  it("inside an outer transaction the write joins it", async () => {
    const adapter = profiles.dbAdapter as SqliteAdapter;
    await adapter.withTransaction(async () => {
      await profiles.insertOne(profile(1));
      await profiles.updateOne({ id: 1, tags: { $insert: ["z"] } });
    });
    expect(begins()).toBe(1);
    expect((await profiles.findById(1)).tags).toEqual(["a", "z"]);
  });

  it("errors map exactly as before without the transaction", async () => {
    await users.insertOne({ id: 1, email: "a@x.io", name: "a", status: "on" });
    const dup = users.insertOne({ id: 1, email: "b@x.io", name: "b", status: "on" });
    await expect(dup).rejects.toThrow(DbError);
    await expect(dup).rejects.toMatchObject({ code: "CONFLICT" });
    expect(begins()).toBe(0);
  });

  it("insert SQL is reused per column signature (and differs per shape)", async () => {
    await users.insertMany([
      { email: "a@x.io", name: "a", status: "on" },
      { email: "b@x.io", name: "b", status: "on", bio: "hi" },
      { email: "c@x.io", name: "c", status: "on" },
    ]);
    const inserts = driver.statements.filter((sql) => sql.startsWith("INSERT"));
    expect(inserts).toHaveLength(3);
    expect(inserts[0]).toBe(inserts[2]);
    expect(inserts[1]).not.toBe(inserts[0]);
    expect(inserts[1]).toContain('"bio"');
    const rows = await users.findMany({ filter: {}, controls: { $sort: { email: 1 } } });
    expect(rows.map((r: any) => [r.email, r.bio ?? null])).toEqual([
      ["a@x.io", null],
      ["b@x.io", "hi"],
      ["c@x.io", null],
    ]);
  });
});

describe("findManyWithCount", () => {
  it("goes through overridden findMany / count (one-segment path only for the stock adapter)", async () => {
    class TenantAdapter extends SqliteAdapter {
      override async count(query: Parameters<SqliteAdapter["count"]>[0]) {
        return (await super.count(query)) + 1000;
      }
    }
    const driver = new BetterSqlite3Driver(":memory:");
    const users = new DbSpace(() => new TenantAdapter(driver)).getTable(UsersTable) as any;
    await users.ensureTable();
    await users.insertOne({ email: "a@x.io", name: "a", status: "on" });
    const page = await users.findManyWithCount({ filter: {}, controls: {} });
    expect(page.data).toHaveLength(1);
    expect(page.count).toBe(1001);
    driver.close();
  });
});
