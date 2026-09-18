import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { AtscriptDbTable, BaseDbAdapter, DbError } from "@atscript/db";
import type {
  DbQuery,
  FilterExpr,
  TDbDeleteResult,
  TDbInsertManyResult,
  TDbInsertResult,
  TDbUpdateResult,
} from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { getSqliteTxGate, SqliteTxState } from "../tx-gate";

import { prepareFixtures, RecordingDriver, deferred, settledWithin } from "./test-utils";

let VersionedUserTable: any;

/** Records every `exec` (BEGIN/COMMIT/ROLLBACK) and can be told to fail the next BEGIN. */
class FailingBeginDriver extends RecordingDriver {
  failNextBegin = false;
  override exec(sql: string): void {
    if (this.failNextBegin && sql.startsWith("BEGIN")) {
      this.failNextBegin = false;
      this.execs.push(sql);
      throw new Error("injected BEGIN failure");
    }
    super.exec(sql);
  }
}

/** A non-SQLite adapter whose transaction state is a foreign object in the shared ALS. */
class ForeignAdapter extends BaseDbAdapter {
  readonly log: string[] = [];
  protected override async _beginTransaction(): Promise<unknown> {
    this.log.push("begin");
    return { foreign: true };
  }
  protected override async _commitTransaction(): Promise<void> {
    this.log.push("commit");
  }
  protected override async _rollbackTransaction(): Promise<void> {
    this.log.push("rollback");
  }
  async insertOne(): Promise<TDbInsertResult> {
    return { insertedId: 1 };
  }
  async insertMany(): Promise<TDbInsertManyResult> {
    return { insertedCount: 0, insertedIds: [] };
  }
  async replaceOne(): Promise<TDbUpdateResult> {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async updateOne(): Promise<TDbUpdateResult> {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async deleteOne(): Promise<TDbDeleteResult> {
    return { deletedCount: 0 };
  }
  async findOne(_q: DbQuery): Promise<Record<string, unknown> | null> {
    return null;
  }
  async findMany(): Promise<Array<Record<string, unknown>>> {
    return [];
  }
  async count(): Promise<number> {
    return 0;
  }
  async updateMany(_f: FilterExpr): Promise<TDbUpdateResult> {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async replaceMany(): Promise<TDbUpdateResult> {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async deleteMany(): Promise<TDbDeleteResult> {
    return { deletedCount: 0 };
  }
  async aggregate(): Promise<Array<Record<string, unknown>>> {
    return [];
  }
  async syncIndexes(): Promise<void> {}
  async ensureTable(): Promise<void> {}
}

describe("SQLite transaction gate (per-driver FIFO serialisation, since 0.1.128)", () => {
  let inner: BetterSqlite3Driver;
  let driver: FailingBeginDriver;
  let adapter: SqliteAdapter;
  let users: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    VersionedUserTable = (await import("./fixtures/version-occ.as")).VersionedUserTable;
  });

  beforeEach(async () => {
    inner = new BetterSqlite3Driver(":memory:");
    driver = new FailingBeginDriver(inner);
    adapter = new SqliteAdapter(driver);
    users = new AtscriptDbTable(VersionedUserTable, adapter);
    await users.ensureTable();
    driver.execs.length = 0;
  });

  afterEach(() => {
    driver.close();
  });

  const seed = (id: number) =>
    users.insertOne({ id, name: `u${id}`, status: "active", counter: 0 } as any);
  const read = async (id: number) =>
    (await users.findOne({ filter: { id }, controls: {} })) as Record<string, any> | null;

  // WHY: at HEAD the second BEGIN failed with "cannot start a transaction
  // within a transaction". Both must now succeed, strictly one after the other.
  it("two concurrent withTransaction calls run one after the other (BEGIN IMMEDIATE … COMMIT, then the next)", async () => {
    const gateA = deferred();
    const gateB = deferred();
    const order: string[] = [];
    const a = adapter.withTransaction(async () => {
      order.push("A:start");
      await seed(1);
      await gateA.promise;
      order.push("A:end");
    });
    const b = adapter.withTransaction(async () => {
      order.push("B:start");
      await seed(2);
      await gateB.promise;
      order.push("B:end");
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["A:start"]); // B is queued behind A
    gateB.resolve(); // B cannot finish before it even starts
    gateA.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"]);
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "COMMIT", "BEGIN IMMEDIATE", "COMMIT"]);
  });

  // WHY: I7 — a statement from another context must not run inside an open
  // transaction (it would see uncommitted rows and be undone by a rollback).
  it("a plain read from a third context waits for COMMIT and never sees uncommitted rows", async () => {
    const hold = deferred();
    const tx = adapter.withTransaction(async () => {
      await seed(1);
      await hold.promise;
    });
    await new Promise((r) => setTimeout(r, 5));
    const readP = read(1);
    expect(await settledWithin(readP, 20)).toBe("pending");
    hold.resolve();
    await tx;
    expect((await readP)?.id).toBe(1); // resolved after COMMIT, sees the committed row
  });

  it("a plain read waits for ROLLBACK and then sees nothing", async () => {
    const hold = deferred();
    const tx = adapter
      .withTransaction(async () => {
        await seed(1);
        await hold.promise;
        throw new Error("boom");
      })
      .catch((e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 5));
    const readP = read(1);
    expect(await settledWithin(readP, 20)).toBe("pending");
    hold.resolve();
    expect(await tx).toBe("boom");
    expect(await readP).toBeNull();
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("a rollback releases the gate for the next transaction", async () => {
    await adapter
      .withTransaction(async () => {
        throw new Error("first fails");
      })
      .catch(() => undefined);
    expect(getSqliteTxGate(driver).held).toBe(false);
    await adapter.withTransaction(async () => seed(1));
    expect((await read(1))?.id).toBe(1);
  });

  it("a BEGIN failure releases the gate", async () => {
    driver.failNextBegin = true;
    await expect(adapter.withTransaction(async () => seed(1))).rejects.toThrow(
      "injected BEGIN failure",
    );
    expect(getSqliteTxGate(driver).held).toBe(false);
    await adapter.withTransaction(async () => seed(2));
    expect((await read(2))?.id).toBe(2);
  });

  it("nested table operations inside a held transaction join it (no deadlock)", async () => {
    await adapter.withTransaction(async () => {
      await users.insertMany([
        { id: 1, name: "a", status: "s", counter: 0 },
        { id: 2, name: "b", status: "s", counter: 0 },
      ] as any[]);
      expect((await read(1))?.id).toBe(1); // read inside the same tx sees the row
      await users.updateOne({ id: 1, name: "a2" } as any);
    });
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    expect((await read(1))?.name).toBe("a2");
  });

  it("transactionWaitTimeoutMs rejects a waiter with DbError TX_WAIT_TIMEOUT", async () => {
    const bounded = new SqliteAdapter(driver, { transactionWaitTimeoutMs: 20 });
    const boundedUsers = new AtscriptDbTable(VersionedUserTable, bounded);
    const hold = deferred();
    const tx = adapter.withTransaction(async () => hold.promise);
    await new Promise((r) => setTimeout(r, 5));
    const err = await boundedUsers.findOne({ filter: { id: 1 }, controls: {} }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("TX_WAIT_TIMEOUT");
    expect((err as DbError).message).toContain("transactionWaitTimeoutMs exceeded");
    hold.resolve();
    await tx;
  });

  it("transactionWaitWarnMs logs a warning through the adapter logger while waiting", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const warning = new SqliteAdapter(driver, { transactionWaitWarnMs: 5 });
    const warnUsers = new AtscriptDbTable(VersionedUserTable, warning, logger);
    const hold = deferred();
    const tx = adapter.withTransaction(async () => hold.promise);
    await new Promise((r) => setTimeout(r, 2));
    const readP = warnUsers.findOne({ filter: { id: 1 }, controls: {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(logger.warn).toHaveBeenCalled();
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain("waiting");
    hold.resolve();
    await tx;
    await readP;
  });

  // WHY (review #13, owner branding): the ALS transaction chain is shared
  // across adapters. A MySQL-outer context is "no transaction of mine" for
  // SQLite: its statements are still gated by the open SQLite transaction and
  // its own withTransaction opens a real SQLite transaction (queued behind the
  // first) instead of silently joining the foreign one.
  it("branded state: a foreign transaction context still gates SQLite statements", async () => {
    const foreign = new ForeignAdapter();
    new AtscriptDbTable(VersionedUserTable, foreign); // registers a readable (logger etc.)
    const hold = deferred();
    const tx = adapter.withTransaction(async () => {
      await seed(1);
      await hold.promise;
    });
    await new Promise((r) => setTimeout(r, 5));
    const outer = foreign.withTransaction(async () => {
      // Inside the foreign context the SQLite adapter's withTransaction is a
      // NEW SQLite transaction: it waits for the real one to COMMIT first.
      return adapter.withTransaction(async () => read(1));
    });
    expect(await settledWithin(outer, 20)).toBe("pending");
    hold.resolve();
    await tx;
    expect((await outer)?.id).toBe(1);
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "COMMIT", "BEGIN IMMEDIATE", "COMMIT"]);
    expect(foreign.log).toEqual(["begin", "commit"]);
  });

  // WHY (since 0.1.128, owner branding): the core brands transaction state by
  // `_transactionOwner()` (the driver here). A foreign OUTER transaction is
  // "no transaction of mine": SQLite opens its own inside it, and the foreign
  // adapter's nested withTransaction inside SQLite's opens its own too —
  // neither family ever sees the other's state, and SQLite statements issued
  // inside the foreign inner callback still run inside the SQLite transaction.
  it("SQLite-outer + foreign-inner: the foreign adapter opens its own transaction, SQLite statements stay in the SQLite one", async () => {
    const foreign = new ForeignAdapter();
    new AtscriptDbTable(VersionedUserTable, foreign);
    await adapter.withTransaction(async () => {
      await seed(1);
      await foreign.withTransaction(async () => {
        await seed(2); // still inside the SQLite transaction — no wait, no second BEGIN
        expect((await read(1))?.id).toBe(1);
      });
      await seed(3);
    });
    expect(foreign.log).toEqual(["begin", "commit"]);
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    expect((await read(2))?.id).toBe(2);
    expect((await read(3))?.id).toBe(3);
  });

  it("foreign-outer + SQLite-inner: SQLite opens its own transaction (BEGIN/COMMIT) and a throw rolls back only its own", async () => {
    const foreign = new ForeignAdapter();
    new AtscriptDbTable(VersionedUserTable, foreign);
    await foreign.withTransaction(async () => {
      await adapter.withTransaction(async () => seed(1));
      await adapter
        .withTransaction(async () => {
          await seed(2);
          throw new Error("inner boom");
        })
        .catch(() => undefined);
    });
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "COMMIT", "BEGIN IMMEDIATE", "ROLLBACK"]);
    expect(foreign.log).toEqual(["begin", "commit"]);
    expect((await read(1))?.id).toBe(1);
    expect(await read(2)).toBeNull();
  });

  it("_beginTransaction returns a SqliteTxState whose release frees this driver's gate", async () => {
    const gate = getSqliteTxGate(driver);
    const probe = adapter as unknown as { _beginTransaction(): Promise<unknown> };
    const state = (await probe._beginTransaction()) as SqliteTxState;
    expect(state).toBeInstanceOf(SqliteTxState);
    expect(gate.held).toBe(true);
    driver.exec("ROLLBACK");
    state.release();
    expect(gate.held).toBe(false);
  });

  it("_withExclusiveConnection holds the connection without a transaction and lets nested transactions BEGIN", async () => {
    const probe = adapter as unknown as {
      _withExclusiveConnection<T>(fn: () => Promise<T>): Promise<T>;
    };
    const hold = deferred();
    const exclusive = probe._withExclusiveConnection(async () => {
      expect(getSqliteTxGate(driver).held).toBe(true);
      await adapter.withTransaction(async () => seed(1)); // BEGIN/COMMIT on the held connection
      await hold.promise;
    });
    await new Promise((r) => setTimeout(r, 5));
    const readP = read(1);
    expect(await settledWithin(readP, 20)).toBe("pending");
    hold.resolve();
    await exclusive;
    expect(getSqliteTxGate(driver).held).toBe(false);
    expect((await readP)?.id).toBe(1);
    expect(driver.execs).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });

  // WHY: finding 42 + finding 14 together — 50 concurrent versioned touches,
  // each inside its own transaction with a CAS-retry loop, yield exactly 50 bumps.
  it("50 concurrent CAS touches (each in a transaction, with retry) → exactly 50 bumps", async () => {
    await seed(1);
    const touch = async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const done = await adapter.withTransaction(async () => {
          const row = await read(1);
          const r = await users.updateOne({ id: 1, $cas: { version: row!.version } } as any);
          return r.matchedCount === 1;
        });
        if (done) return;
      }
      throw new Error("touch never committed");
    };
    await Promise.all(Array.from({ length: 50 }, () => touch()));
    expect((await read(1))?.version).toBe(50);
  });
});
