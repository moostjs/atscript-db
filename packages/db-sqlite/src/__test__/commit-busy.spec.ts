import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbError, DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import type { TSqliteRunResult } from "../types";
import { caught, expectLockTimeout, prepareFixtures, RecordingDriver } from "./test-utils";

/** The driver error's identifying fields (better-sqlite3 sets `code`, node:sqlite `errcode`). */
interface TFailure {
  code?: string;
  errcode?: number;
  message?: string;
}

/**
 * Fails the next statement a test names, like a contended driver does: the
 * statement does not run (a failed COMMIT leaves the transaction open).
 * Matches on the SQL prefix; each failure fires once.
 */
class FailingDriver extends RecordingDriver {
  private readonly _failures: Array<{ sql: string; failure: TFailure }> = [];

  failNext(sql: string, failure: TFailure): void {
    this._failures.push({ sql, failure });
  }

  override exec(sql: string): void {
    this._failIf(sql, this.execs);
    super.exec(sql);
  }

  override run(sql: string, params?: unknown[]): TSqliteRunResult {
    this._failIf(sql, this.statements);
    return super.run(sql, params);
  }

  override all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    this._failIf(sql, this.statements);
    return super.all<T>(sql, params);
  }

  override get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    this._failIf(sql, this.statements);
    return super.get<T>(sql, params);
  }

  /** Throws (and records `sql` in `log`) when a failure is registered for it. */
  private _failIf(sql: string, log: string[]): void {
    const i = this._failures.findIndex((f) => sql.startsWith(f.sql));
    if (i === -1) return;
    const { message = "database is locked", ...fields } = this._failures.splice(i, 1)[0]!.failure;
    log.push(sql);
    throw Object.assign(new Error(message), fields);
  }
}

/** Every busy shape the adapter recognises: better-sqlite3's `code` and node:sqlite's (extended) `errcode`. */
const BUSY: Array<[string, TFailure]> = [
  ["code SQLITE_BUSY", { code: "SQLITE_BUSY" }],
  ["code SQLITE_BUSY_SNAPSHOT", { code: "SQLITE_BUSY_SNAPSHOT" }],
  ["errcode 5", { errcode: 5 }],
  ["errcode 517 = SQLITE_BUSY_SNAPSHOT", { errcode: 517 }],
];

/** `SQLITE_LOCKED` is a conflict on the same connection (or shared cache), not contention. */
const LOCKED: Array<[string, TFailure]> = [
  ["code SQLITE_LOCKED", { code: "SQLITE_LOCKED", message: "database table is locked" }],
  ["errcode 6", { errcode: 6, message: "database table is locked" }],
];

const SQLITE_BUSY = { code: "SQLITE_BUSY" };

let fx: Record<string, any>;
let driver: FailingDriver;

/** The recorded `run` / `all` / `get` statements starting with `prefix`. */
const statements = (prefix: string) => driver.statements.filter((s) => s.startsWith(prefix));

/** What `fn` throws (`undefined` when it returns). */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/constraint-errors.as");
});

beforeEach(() => {
  driver = new FailingDriver(new BetterSqlite3Driver(":memory:"));
});

afterEach(() => driver.close());

describe("[sqlite] COMMIT failure", () => {
  let adapter: SqliteAdapter;

  beforeEach(() => {
    adapter = new SqliteAdapter(driver);
    driver.execs.length = 0; // the adapter's own PRAGMA
  });

  it.each(BUSY)(
    "SQLITE_BUSY (%s) is a retryable LOCK_TIMEOUT with the driver error as cause",
    async (_n, shape) => {
      driver.failNext("COMMIT", shape);
      expectLockTimeout(await caught(adapter.withTransaction(async () => {})), shape);
    },
  );

  it("the gate stays held until ROLLBACK: a queued transaction begins only after it", async () => {
    driver.failNext("COMMIT", SQLITE_BUSY);
    const first = caught(adapter.withTransaction(async () => {}));
    const second = adapter.withTransaction(async () => "second");
    await first;
    expect(await second).toBe("second");
    expect(driver.execs).toEqual([
      "BEGIN IMMEDIATE",
      "COMMIT",
      "ROLLBACK",
      "BEGIN IMMEDIATE",
      "COMMIT",
    ]);
  });

  it("another COMMIT failure passes through unchanged and still rolls back", async () => {
    driver.failNext("COMMIT", { code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
    const error = await adapter.withTransaction(async () => {}).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(DbError);
    expect((error as Error).message).toBe("database is locked");
    expect(driver.execs.at(-1)).toBe("ROLLBACK");
  });
});

// Since 0.1.177 SQLITE_BUSY is a LOCK_TIMEOUT everywhere, not only at COMMIT:
// in WAL mode (the recommended setup) a reader does not make COMMIT busy —
// contention surfaces at BEGIN IMMEDIATE and on autocommit statements, where
// the raw driver error left apps no supported way to detect it. The real-file
// counterpart is busy-contention.spec.ts.
describe("[sqlite] SQLITE_BUSY outside COMMIT", () => {
  let space: DbSpace;
  let households: any;

  beforeEach(async () => {
    space = new DbSpace(() => new SqliteAdapter(driver));
    households = space.getTable(fx.CeHousehold as never);
    await households.ensureTable();
    driver.execs.length = 0;
  });

  it.each(BUSY)(
    "a busy BEGIN (%s) opened nothing: LOCK_TIMEOUT, callback not run, no ROLLBACK, gate free for a retry",
    async (_n, shape) => {
      driver.failNext("BEGIN IMMEDIATE", shape);
      const callback = vi.fn(async () => {});
      expectLockTimeout(await caught(households.dbAdapter.withTransaction(callback)), shape);
      expect(callback).not.toHaveBeenCalled();
      // nothing was opened, so nothing is rolled back
      expect(driver.execs).toEqual(["BEGIN IMMEDIATE"]);
      // the gate was released: the retry begins and commits
      expect(await households.dbAdapter.withTransaction(async () => "retried")).toBe("retried");
      expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "BEGIN IMMEDIATE", "COMMIT"]);
    },
  );

  it.each(BUSY)(
    "a busy statement (%s) did not run: LOCK_TIMEOUT, the row is absent, a retry writes it",
    async (_n, shape) => {
      driver.failNext("INSERT", shape);
      expectLockTimeout(await caught(households.insertOne({ id: 1, name: "a" })), shape);
      expect(await households.count()).toBe(0);
      await households.insertOne({ id: 1, name: "a" });
      expect(await households.count()).toBe(1);
    },
  );

  it("a busy statement inside withTransaction: LOCK_TIMEOUT after the ROLLBACK, the gate free for the next transaction", async () => {
    driver.failNext("INSERT", SQLITE_BUSY);
    const tx = households.dbAdapter.withTransaction(() =>
      households.insertOne({ id: 1, name: "a" }),
    );
    expectLockTimeout(await caught(tx), SQLITE_BUSY);
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
    expect(await households.dbAdapter.withTransaction(async () => "next")).toBe("next");
    expect(await households.count()).toBe(0);
  });

  it("a busy increment seed fails ensureTable retryably; the retry still seeds the start value", async () => {
    // before 0.1.177 the seed was marked done before it ran: the retry skipped it, ids started at 1
    const { CounterTable } = await import("./fixtures/default-fns.as");
    const counters = space.getTable(CounterTable as never) as any;
    driver.failNext("INSERT OR IGNORE INTO sqlite_sequence", SQLITE_BUSY);
    expectLockTimeout(await caught(counters.ensureTable()), SQLITE_BUSY);
    await counters.ensureTable();
    expect((await counters.insertOne({ label: "a" })).insertedId).toBe(1000);
  });

  it("a busy index read in planIndexes is a LOCK_TIMEOUT too", async () => {
    driver.failNext("PRAGMA index_list", SQLITE_BUSY);
    expectLockTimeout(await caught(households.dbAdapter.planIndexes()), SQLITE_BUSY);
    expect(await households.dbAdapter.planIndexes()).toEqual([]);
  });

  it.each(LOCKED)(
    "%s is not contention between connections: it stays the raw driver error",
    async (_n, shape) => {
      driver.failNext("BEGIN IMMEDIATE", shape);
      const atBegin = await households.dbAdapter
        .withTransaction(async () => {})
        .catch((e: unknown) => e);
      expect(atBegin).not.toBeInstanceOf(DbError);
      expect(atBegin).toMatchObject(shape);

      driver.failNext("INSERT", shape);
      const onStatement = await households.insertOne({ id: 1, name: "a" }).catch((e: unknown) => e);
      expect(onStatement).not.toBeInstanceOf(DbError);
      expect(onStatement).toMatchObject(shape);
    },
  );

  it("a constraint failure still becomes CONFLICT, not LOCK_TIMEOUT", async () => {
    await households.insertOne({ id: 1, name: "a" });
    const error = await caught(households.insertOne({ id: 1, name: "b" }));
    expect(error.code).toBe("CONFLICT");
    expect(error.retryable).toBe(false);
  });
});

// A capability probe that fails because the database is busy has no answer:
// it throws the retryable LOCK_TIMEOUT, keeps nothing, and the next call
// probes again. Before 0.1.177 the `false` was kept for the life of the
// process, so one contended first probe disabled geo / vector search until a
// restart; a `false` for that call alone would still turn into a
// non-retryable GEO_NOT_SUPPORTED, or a vector column typed TEXT.
describe("[sqlite] capability probes on a busy database", () => {
  let adapter: SqliteAdapter;

  beforeEach(() => {
    adapter = new SqliteAdapter(driver);
  });

  it("a busy math-function probe throws LOCK_TIMEOUT and keeps nothing; the next probe decides", () => {
    driver.failNext("SELECT radians(0)", SQLITE_BUSY);
    expectLockTimeout(
      thrown(() => adapter.isGeoSearchable()),
      SQLITE_BUSY,
    );
    expect(adapter.isGeoSearchable()).toBe(true);
    expect(adapter.isGeoSearchable()).toBe(true);
    expect(statements("SELECT radians(0)")).toHaveLength(2);
  });

  it("a missing math function is a real answer: false is kept, no second probe", () => {
    driver.failNext("SELECT radians(0)", { message: "no such function: radians" });
    expect(adapter.isGeoSearchable()).toBe(false);
    expect(adapter.isGeoSearchable()).toBe(false);
    expect(statements("SELECT radians(0)")).toHaveLength(1);
  });

  it("a busy vector probe throws LOCK_TIMEOUT and keeps nothing; the next probe decides", () => {
    // RecordingDriver has no `hasVectorExt`, so the adapter probes `vec_version()`
    const vector = new Map([["db.search.vector", { dimensions: 3 }]]);
    adapter.onFieldScanned("embedding", undefined, vector as never);
    driver.failNext("SELECT vec_version()", { errcode: 5 });
    expectLockTimeout(
      thrown(() => adapter.isVectorSearchable()),
      { errcode: 5 },
    );
    // sqlite-vec is not loaded: the second probe fails for real and that answer is kept
    expect(adapter.isVectorSearchable()).toBe(false);
    expect(adapter.isVectorSearchable()).toBe(false);
    expect(statements("SELECT vec_version()")).toHaveLength(2);
  });
});

// A vector field's formatter is built with the table metadata — synchronous,
// at first use, where a busy probe must not throw — so it does not probe: a
// value decides when it is formatted and a read accepts a BLOB or JSON text
// (a write arrives as JSON text). The column type needs the answer,
// so a busy probe fails the schema step retryably.
describe("[sqlite] vector fields probe on use, not while the metadata is built", () => {
  const embedding = Array.from({ length: 512 }, () => 0.5);

  it("a busy probe fails ensureTable retryably; building a table's metadata never probes", async () => {
    const { Document } = await import("./fixtures/vector-table.as");
    const probes = () => statements("SELECT vec_version()");

    const setup = new DbSpace(() => new SqliteAdapter(driver)).getTable(Document as never) as any;
    driver.failNext("SELECT vec_version()", SQLITE_BUSY);
    expectLockTimeout(await caught(setup.ensureTable()), SQLITE_BUSY);
    await setup.ensureTable(); // sqlite-vec is not loaded: a TEXT column
    expect(probes()).toHaveLength(2);

    // a fresh adapter, nothing answered yet: its metadata (and formatters) is built without a probe
    const docs = new DbSpace(() => new SqliteAdapter(driver)).getTable(Document as never) as any;
    expect(docs.fieldDescriptors.length).toBeGreaterThan(0);
    expect(probes()).toHaveLength(2);

    await docs.insertOne({ id: "d1", title: "t", embedding });
    expect((await docs.findById("d1"))?.embedding).toEqual(embedding);
  });
});
