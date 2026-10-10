import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vite-plus/test";
import { DbSpace, isRetryableDbError } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise (CI has no server). Override with `ATSCRIPT_PG_TEST_URL` (or
// `POSTGRES_TEST_URI`; an admin connection — the spec creates and drops its
// own database). Row locks of a conflict-ignoring insert inside a caller's
// transaction (since 0.1.153): `ON CONFLICT DO NOTHING` takes no lock on a
// stored row, `lockConflicts` locks them FOR UPDATE.

const DB = "insert_ignore_locking";

const reachable = await pgReachable();

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

describe.skipIf(!reachable)("[postgres live] onConflict: ignore row locks", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/insert-ignore.as");
    const driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
    space = new DbSpace(() => new PostgresAdapter(driver), { onClose: () => driver.close() });
    const result = await new SchemaSync(space).run([fx.IgItem], { force: true });
    expect(result.status).toBe("synced");
  });

  afterAll(async () => {
    await space?.close();
    await dropPgDatabase(DB, { force: true });
  });

  const items = () => t(fx.IgItem);
  const adapter = (): PostgresAdapter => items().dbAdapter;

  beforeEach(async () => {
    await items().deleteMany({});
    await items().insertOne(item(1, "a"));
  });

  it("ignore-insert of a stored row then update in two transactions: no deadlock (DO NOTHING takes no lock)", async () => {
    const meet = barrier(2);
    const run = (newId: number) =>
      adapter().withTransaction(async () => {
        await items().insertMany([item(1, "a"), item(newId, `n${newId}`)], {
          onConflict: "ignore",
        });
        await meet();
        await items().updateOne({ id: 1, qty: newId });
      });
    const results = await Promise.allSettled([run(2), run(3)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  });

  it("lockConflicts serializes — the second transaction's insert waits for the first to commit", async () => {
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

  it("without lockConflicts a concurrent transaction is not blocked by the skipped row", async () => {
    let inserted!: () => void;
    const t1Inserted = new Promise<void>((r) => (inserted = r));
    let done!: () => void;
    const outsideDone = new Promise<void>((r) => (done = r));
    const t1 = adapter().withTransaction(async () => {
      await items().insertMany([item(1, "a"), item(2, "b")], { onConflict: "ignore" });
      inserted();
      await outsideDone;
    });
    await t1Inserted;
    const started = Date.now();
    await items().updateOne({ id: 1, qty: 7 });
    expect(Date.now() - started).toBeLessThan(2000);
    done();
    await t1;
  });

  it("a deadlock is a retryable DEADLOCK", async () => {
    await items().insertOne(item(2, "b"));
    const meet = barrier(2);
    const run = (first: number, second: number) =>
      adapter().withTransaction(async () => {
        await items().updateOne({ id: first, qty: 5 });
        await meet();
        await items().updateOne({ id: second, qty: 5 });
      });
    const results = await Promise.allSettled([run(1, 2), run(2, 1)]);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "DEADLOCK", retryable: true });
    expect(isRetryableDbError(rejected[0]!.reason)).toBe(true);
  });

  it("a lock_timeout is a retryable LOCK_TIMEOUT", async () => {
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
        await (adapter() as any)._exec().run("SET LOCAL lock_timeout = '300ms'");
        await items().updateOne({ id: 1, qty: 3 });
      })
      .catch((e: unknown) => e);
    done();
    await t1;
    expect(error).toMatchObject({ code: "LOCK_TIMEOUT", retryable: true });
  });
});
