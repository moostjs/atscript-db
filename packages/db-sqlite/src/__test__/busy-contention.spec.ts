import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { caught, expectLockTimeout, prepareFixtures, RecordingDriver } from "./test-utils";

// Real contention between two connections on one file (busy timeout 0, so
// every wait fails at once — no timing involved). Since 0.1.177 SQLITE_BUSY is
// the retryable LOCK_TIMEOUT at BEGIN IMMEDIATE, on every statement and in
// schema steps, not only at COMMIT. In WAL mode (the recommended setup) a
// reader does not make COMMIT busy, so these are the contention points an app
// actually meets. The fake-driver unit cases are in commit-busy.spec.ts.

type TMode = "delete" | "wal";
const MODES: TMode[] = ["delete", "wal"];

let fx: Record<string, any>;
let dir: string;
let cleanups: Array<() => void | Promise<void>>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/constraint-errors.as");
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "asdb-busy-"));
  cleanups = [];
});

afterEach(async () => {
  // last opened, first closed
  for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A space over `busy.db` in `mode` with the `ce_households` table, and a
 * second connection (`blocker`) on the same file. `execs` records the
 * adapter's BEGIN / COMMIT / ROLLBACK.
 */
async function open(mode: TMode) {
  const raw = new Database(join(dir, "busy.db"), { timeout: 0 });
  raw.pragma(`journal_mode = ${mode}`);
  const driver = new RecordingDriver(new BetterSqlite3Driver(raw));
  const space = new DbSpace(() => new SqliteAdapter(driver), { onClose: () => driver.close() });
  cleanups.push(() => space.close());
  const households = space.getTable(fx.CeHousehold as never) as any;
  await households.ensureTable();
  const blocker = new Database(join(dir, "busy.db"), { timeout: 0 });
  cleanups.push(() => {
    if (blocker.inTransaction) blocker.exec("ROLLBACK");
    blocker.close();
  });
  driver.execs.length = 0;
  return {
    raw,
    driver,
    space,
    households,
    adapter: households.dbAdapter as SqliteAdapter,
    blocker,
  };
}

/** What a real busy database fails with: the driver error is the LOCK_TIMEOUT's cause. */
const SQLITE_BUSY = { code: "SQLITE_BUSY" };

describe("[sqlite] busy BEGIN IMMEDIATE", () => {
  it.each(MODES)(
    "[%s] opened nothing: LOCK_TIMEOUT, callbacks not run, the gate passes to the next waiter, a retry succeeds",
    async (mode) => {
      const { raw, driver, households, adapter, blocker } = await open(mode);
      blocker.exec("BEGIN IMMEDIATE");

      const first = vi.fn(async () => {});
      const queued = vi.fn(async () => {});
      const a = caught(adapter.withTransaction(first));
      // waits at the gate behind `a`, then meets the same busy database
      const b = caught(adapter.withTransaction(queued));
      expectLockTimeout(await a, SQLITE_BUSY);
      expectLockTimeout(await b, SQLITE_BUSY);
      expect(first).not.toHaveBeenCalled();
      expect(queued).not.toHaveBeenCalled();
      expect(raw.inTransaction).toBe(false);
      // two BEGINs and nothing to roll back: the failed one freed the gate for the queued one
      expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "BEGIN IMMEDIATE"]);

      // a multi-row insertMany opens a transaction: the same LOCK_TIMEOUT
      expectLockTimeout(
        await caught(
          households.insertMany([
            { id: 1, name: "a" },
            { id: 2, name: "b" },
          ]),
        ),
        SQLITE_BUSY,
      );

      blocker.exec("ROLLBACK");
      await adapter.withTransaction(async () => {
        await households.insertOne({ id: 1, name: "a" });
      });
      expect(await households.count()).toBe(1);
    },
  );
});

describe("[sqlite] busy autocommit statement", () => {
  it.each(MODES)(
    "[%s] a write under another connection's write lock did not apply: LOCK_TIMEOUT, a retry writes it",
    async (mode) => {
      const { households, blocker } = await open(mode);
      blocker.exec("BEGIN IMMEDIATE");
      expectLockTimeout(await caught(households.insertOne({ id: 1, name: "a" })), SQLITE_BUSY);
      blocker.exec("ROLLBACK");
      expect(await households.count()).toBe(0);
      await households.insertOne({ id: 1, name: "a" });
      expect(await households.count()).toBe(1);
    },
  );

  it("[delete] a read under another connection's EXCLUSIVE lock is a LOCK_TIMEOUT", async () => {
    const { households, blocker } = await open("delete");
    blocker.exec("BEGIN EXCLUSIVE");
    blocker.exec(`INSERT INTO "ce_households" ("id", "name") VALUES (9, 'x')`);
    expectLockTimeout(await caught(households.findMany({})), SQLITE_BUSY);
    blocker.exec("ROLLBACK");
    expect(await households.findMany({})).toEqual([]);
  });

  it("[wal] reads never wait: the same read succeeds and sees only committed rows", async () => {
    const { households, blocker } = await open("wal");
    blocker.exec("BEGIN EXCLUSIVE");
    blocker.exec(`INSERT INTO "ce_households" ("id", "name") VALUES (9, 'x')`);
    expect(await households.findMany({})).toEqual([]);
  });
});

describe("[sqlite] busy COMMIT", () => {
  it("[delete] a reader holding SHARED fails COMMIT: LOCK_TIMEOUT after the rollback, the row is absent, the gate free", async () => {
    const { raw, driver, households, adapter, blocker } = await open("delete");
    const tx = adapter.withTransaction(async () => {
      await households.insertOne({ id: 1, name: "a" });
      // another connection starts reading: SHARED blocks our COMMIT's EXCLUSIVE lock
      blocker.exec("BEGIN");
      blocker.prepare(`SELECT count(*) AS n FROM "ce_households"`).get();
    });
    expectLockTimeout(await caught(tx), SQLITE_BUSY);
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);
    expect(raw.inTransaction).toBe(false);
    blocker.exec("COMMIT");
    expect(await households.count()).toBe(0);
    expect(await adapter.withTransaction(async () => "free")).toBe("free");
  });

  it("[wal] the same reader does not block COMMIT: the write lock is held from BEGIN IMMEDIATE", async () => {
    const { households, adapter, blocker } = await open("wal");
    await adapter.withTransaction(async () => {
      await households.insertOne({ id: 1, name: "a" });
      blocker.exec("BEGIN");
      blocker.prepare(`SELECT count(*) AS n FROM "ce_households"`).get();
    });
    blocker.exec("COMMIT");
    expect(await households.count()).toBe(1);
  });
});

describe("[sqlite] busy schema step", () => {
  it.each(MODES)(
    "[%s] ensureTable, dropTablesByName and syncSchema are LOCK_TIMEOUT; PRAGMA foreign_keys is restored",
    async (mode) => {
      const { driver, space, adapter, blocker } = await open(mode);
      const people = space.getTable(fx.CePerson as never) as any;
      blocker.exec("BEGIN IMMEDIATE");

      expectLockTimeout(await caught(people.ensureTable()), SQLITE_BUSY);
      expectLockTimeout(await caught(adapter.dropTablesByName(["ce_households"])), SQLITE_BUSY);
      // dropTablesByName turns foreign keys off for its drops — and back on although it failed
      expect(driver.get<{ foreign_keys: number }>("PRAGMA foreign_keys")).toEqual({
        foreign_keys: 1,
      });
      expectLockTimeout(await caught(syncSchema(space, [fx.CePerson])), SQLITE_BUSY);

      blocker.exec("ROLLBACK");
      await people.ensureTable();
      expect(await people.count()).toBe(0);
    },
  );

  it.each(MODES)(
    "[%s] syncIndexes stops at the first busy CREATE INDEX: LOCK_TIMEOUT, not a collected failure per index",
    async (mode) => {
      // Before 0.1.177 each index's busy error was collected as a plain message and
      // the next index tried again (one more busy_timeout wait each), ending in a
      // code-less Error("index sync failed …").
      const { driver, space, blocker } = await open(mode);
      const items = space.getTable(fx.CeItem as never) as any;
      await items.ensureTable();
      driver.execs.length = 0;
      blocker.exec("BEGIN IMMEDIATE");

      expectLockTimeout(await caught(items.syncIndexes()), SQLITE_BUSY);
      expect(driver.execs.filter((sql) => sql.startsWith("CREATE UNIQUE INDEX"))).toHaveLength(1);

      blocker.exec("ROLLBACK");
      await items.syncIndexes();
      const indexes = driver.all<{ name: string }>(`PRAGMA index_list("ce_items")`);
      expect(indexes.filter((i) => i.name.startsWith("atscript__"))).toHaveLength(2);
    },
  );

  it.each(MODES)(
    "[%s] a busy recreateTable restores legacy_alter_table and foreign_keys and keeps the rows",
    async (mode) => {
      const { driver, households, adapter, blocker } = await open(mode);
      await households.insertOne({ id: 1, name: "a" });
      driver.execs.length = 0;
      blocker.exec("BEGIN IMMEDIATE");

      expectLockTimeout(await caught(adapter.recreateTable()), SQLITE_BUSY);
      expect(driver.execs).toEqual([
        "PRAGMA foreign_keys = OFF",
        "PRAGMA legacy_alter_table = ON",
        "BEGIN IMMEDIATE",
        "PRAGMA legacy_alter_table = OFF",
        "PRAGMA foreign_keys = ON",
      ]);
      expect(driver.get("PRAGMA legacy_alter_table")).toEqual({ legacy_alter_table: 0 });
      expect(driver.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });

      blocker.exec("ROLLBACK");
      expect(await households.count()).toBe(1);
    },
  );
});
