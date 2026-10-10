import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vite-plus/test";
import { DbError, DbSpace, isRetryableDbError } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import {
  mysqlReachable,
  mysqlDbUrl,
  recreateMysqlDatabase,
  dropMysqlDatabase,
} from "./live-server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips
// otherwise (CI has no server). Override with `ATSCRIPT_MYSQL_TEST_URL` (or
// `MYSQL_TEST_URI`; an admin connection — the spec creates and drops its own
// database). Row locks of a conflict-ignoring insert inside a caller's
// transaction (since 0.1.153): a failed duplicate INSERT leaves InnoDB's
// shared lock on the stored row until COMMIT, so two transactions that
// ignore-insert the same stored row and then update it deadlock (S→X).

const DB = "insert_ignore_locking";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let space: DbSpace;
const t = (type: unknown): any => space.getTable(type as never);
const item = (id: number, sku: string, qty = 1) => ({ id, sku, qty });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves once `n` callers are waiting on it. */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((r) => (release = r));
  return () => {
    if (++arrived === n) release();
    return all;
  };
}

describe.skipIf(!reachable)("[mysql live] onConflict: ignore row locks", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/insert-ignore.as");
    const driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
    const result = await new SchemaSync(space).run([fx.IgItem, fx.IgAuto], { force: true });
    expect(result.status).toBe("synced");
  });

  afterAll(async () => {
    await space?.close();
    await dropMysqlDatabase(DB);
  });

  const items = () => t(fx.IgItem);
  const adapter = (): MysqlAdapter => items().dbAdapter;

  beforeEach(async () => {
    await items().deleteMany({});
    await t(fx.IgAuto).deleteMany({});
    await items().insertOne(item(1, "a"));
  });

  /**
   * Two transactions ignore-insert the stored row 1 (plus a new row each),
   * meet, then both update row 1.
   */
  async function overlapThenUpdate(
    insert: (rows: Array<Record<string, unknown>>) => Promise<unknown>,
  ): Promise<PromiseSettledResult<void>[]> {
    const meet = barrier(2);
    const run = (newId: number) =>
      adapter().withTransaction(async () => {
        await insert([item(1, "a"), item(newId, `n${newId}`)]);
        await meet();
        await items().updateOne({ id: 1, qty: newId });
      });
    return Promise.allSettled([run(2), run(3)]);
  }

  it("engine behaviour: the optimistic INSERT path (pre-0.1.153 in a caller's transaction) deadlocks — as a retryable DEADLOCK", async () => {
    // `inCallerTransaction: false` forces the standalone optimistic path inside
    // the caller's transaction — exactly what every ignore-insert did before.
    const results = await overlapThenUpdate((rows) =>
      adapter().insertManyIgnore(rows, { inCallerTransaction: false }),
    );
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({ code: "DEADLOCK", retryable: true });
    expect(isRetryableDbError(error)).toBe(true);
  });

  it("A: inside a caller's transaction the pre-check runs first — no deadlock, both commit", async () => {
    const results = await overlapThenUpdate((rows) =>
      items().insertMany(rows, { onConflict: "ignore" }),
    );
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const stored = (await items().findMany({
      filter: {},
      controls: { $sort: { id: 1 } },
    })) as any[];
    expect(stored.map((r) => r.id)).toEqual([1, 2, 3]);
    expect([2, 3]).toContain(stored[0].qty);
  });

  it("A: the conflicting row is not locked — a concurrent transaction updates it without waiting", async () => {
    let inserted!: () => void;
    const t1Inserted = new Promise<void>((r) => (inserted = r));
    let done!: () => void;
    const t2Done = new Promise<void>((r) => (done = r));
    const t1 = adapter().withTransaction(async () => {
      await items().insertMany([item(1, "a"), item(2, "b")], { onConflict: "ignore" });
      inserted();
      await t2Done; // T1 stays open while T2 runs
    });
    await t1Inserted;
    const started = Date.now();
    await items().updateOne({ id: 1, qty: 7 });
    expect(Date.now() - started).toBeLessThan(2000);
    done();
    await t1;
  });

  it("B: lockConflicts serializes — the second transaction's insert waits for the first to commit", async () => {
    const events: string[] = [];
    let locked!: () => void;
    const t1Locked = new Promise<void>((r) => (locked = r));
    const t1 = adapter().withTransaction(async () => {
      const r = await items().insertMany([item(1, "a"), item(2, "b")], {
        onConflict: "ignore",
        lockConflicts: true,
      });
      expect(r.conflicts).toEqual([0]);
      locked();
      await sleep(700);
      await items().updateOne({ id: 1, qty: 10 });
      events.push("t1 done");
    });
    await t1Locked;
    const started = Date.now();
    const t2 = adapter().withTransaction(async () => {
      const r = await items().insertMany([item(1, "a"), item(3, "c")], {
        onConflict: "ignore",
        lockConflicts: true,
      });
      events.push("t2 locked");
      expect(r.conflicts).toEqual([0]);
      expect(r.insertedIds).toEqual([3]);
      await items().updateOne({ id: 1, qty: { $inc: 1 } });
    });
    await Promise.all([t1, t2]);
    expect(events).toEqual(["t1 done", "t2 locked"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(((await items().findById(1)) as any).qty).toBe(11);
  });

  it("B: only the found keys are locked — no gap lock blocks an insert next to a missing key", async () => {
    let locked!: () => void;
    const t1Locked = new Promise<void>((r) => (locked = r));
    let done!: () => void;
    const outsideDone = new Promise<void>((r) => (done = r));
    const t1 = adapter().withTransaction(async () => {
      // 1 is stored (locked), 9 is new (pre-checked without a lock, then inserted)
      await items().insertMany([item(1, "a"), item(9, "i")], {
        onConflict: "ignore",
        lockConflicts: true,
      });
      locked();
      await outsideDone;
    });
    await t1Locked;
    // a key between the locked 1 and the inserted 9: a gap lock would block it
    const started = Date.now();
    const outcome = await Promise.race([
      items()
        .insertOne(item(5, "e"))
        .then(() => "inserted"),
      sleep(3000).then(() => "blocked"),
    ]);
    expect(outcome).toBe("inserted");
    expect(Date.now() - started).toBeLessThan(2000);
    // …while the found key itself IS locked: an update of row 1 waits until T1 ends
    const waited = items().updateOne({ id: 1, qty: 3 });
    const early = await Promise.race([
      waited.then(() => "updated"),
      sleep(500).then(() => "waiting"),
    ]);
    expect(early).toBe("waiting");
    done();
    await t1;
    await waited;
  });

  it("a row committed after the transaction's snapshot still reports a conflict (race path)", async () => {
    await adapter().withTransaction(async () => {
      // the first consistent read fixes the snapshot
      await items().findMany({ filter: {}, controls: {} });
      // committed outside the transaction: invisible to the pre-check
      const outside = new Mysql2Driver(mysqlDbUrl(DB));
      try {
        await outside.run("INSERT INTO `ig_items` (`id`, `sku`, `qty`) VALUES (?, ?, ?)", [
          9,
          "late",
          1,
        ]);
      } finally {
        await outside.close();
      }
      const r = await items().insertMany([item(9, "late"), item(10, "j")], {
        onConflict: "ignore",
      });
      expect(r.conflicts).toEqual([0]);
      expect(r.insertedIds).toEqual([10]);
    });
  });

  it("explicit ids in a caller's transaction: inserted in key order, ids reported in input order", async () => {
    const r = await adapter().withTransaction(() =>
      items().insertMany([item(5, "e"), item(1, "a"), item(3, "c"), item(4, "d")], {
        onConflict: "ignore",
      }),
    );
    expect(r).toEqual({
      insertedCount: 3,
      insertedIds: [5, 3, 4],
      inserted: [0, 2, 3],
      conflicts: [1],
    });
  });

  it("generated ids in a caller's transaction are the stored ids", async () => {
    const auto = t(fx.IgAuto);
    await auto.insertOne({ sku: "s1", label: "one" });
    const r: any = await adapter().withTransaction(() =>
      auto.insertMany(
        [
          { sku: "s2", label: "two" },
          { sku: "s1", label: "dup" },
          { sku: "s3", label: "three" },
        ],
        { onConflict: "ignore" },
      ),
    );
    const stored = Object.fromEntries(
      ((await auto.findMany({ filter: {}, controls: {} })) as any[]).map((row) => [
        row.sku,
        row.id,
      ]),
    );
    expect(r.conflicts).toEqual([1]);
    expect(r.insertedIds).toEqual([stored.s2, stored.s3]);
  });

  it("a lock wait timeout is a retryable LOCK_TIMEOUT", async () => {
    let locked!: () => void;
    const t1Locked = new Promise<void>((r) => (locked = r));
    let done!: () => void;
    const t2Done = new Promise<void>((r) => (done = r));
    const t1 = adapter().withTransaction(async () => {
      await items().updateOne({ id: 1, qty: 2 });
      locked();
      await t2Done;
    });
    await t1Locked;
    const error = await adapter()
      .withTransaction(async () => {
        const conn = (adapter() as any)._exec();
        await conn.exec("SET SESSION innodb_lock_wait_timeout = 1");
        try {
          await items().updateOne({ id: 1, qty: 3 });
        } finally {
          await conn.exec("SET SESSION innodb_lock_wait_timeout = DEFAULT");
        }
      })
      .catch((e: unknown) => e);
    done();
    await t1;
    expect(error).toMatchObject({ code: "LOCK_TIMEOUT", retryable: true });
  });
});
