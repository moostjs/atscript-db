import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbError, DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";
import { defineReadLockCases } from "../../../db/test-kit/read-lock-cases";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// Server-gated (see insert-ignore-locking.live.spec.ts): locking reads and
// transaction isolation against a live PostgreSQL (since 0.1.162). Each
// `withTransaction` holds its own pooled connection, so two concurrent ones
// are two sessions.

const DB = "read_lock";

const reachable = await pgReachable();

let fx: Record<string, any>;
let space: DbSpace;
/** A second pool — its transactions are another owner's, so they never join one of `space`. */
let other: DbSpace;

describe.skipIf(!reachable)("[postgres live] locking reads and isolation", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/insert-ignore.as");
    const url = await recreatePgDatabase(DB);
    const driver = new PgDriver({ connectionString: url });
    space = new DbSpace(() => new PostgresAdapter(driver), { onClose: () => driver.close() });
    const otherDriver = new PgDriver({ connectionString: url });
    other = new DbSpace(() => new PostgresAdapter(otherDriver), {
      onClose: () => otherDriver.close(),
    });
    const result = await new SchemaSync(space).run([fx.IgItem, fx.IgNote, fx.IgCode], {
      force: true,
    });
    expect(result.status).toBe("synced");
  });

  afterAll(async () => {
    await space?.close();
    await other?.close();
    await dropPgDatabase(DB, { force: true });
  });

  const items = (): any => space.getTable(fx.IgItem);
  const codes = (): any => space.getTable(fx.IgCode);
  const notes = (): any => space.getTable(fx.IgNote);
  const adapter = (): PostgresAdapter => items().getAdapter();

  defineReadLockCases({
    items,
    notes,
    codes,
    skipLockedIsolations: ["repeatable read", "serializable"],
  });

  it("READ COMMITTED (the default) sees a change committed mid-transaction; REPEATABLE READ does not", async () => {
    // Committed by another session (autocommit on the second pool).
    const bump = (qty: number) => other.getTable(fx.IgItem).updateOne({ id: 2, qty } as any);
    const rc = await adapter().withTransaction(async () => {
      const before = ((await items().findById(2)) as any).qty;
      await bump(20);
      const after = ((await items().findById(2)) as any).qty;
      return [before, after];
    });
    expect(rc).toEqual([1, 20]);

    const rr = await adapter().withTransaction(
      async () => {
        const before = ((await items().findById(2)) as any).qty;
        await bump(30);
        return [before, ((await items().findById(2)) as any).qty];
      },
      { isolation: "repeatable read" },
    );
    expect(rr).toEqual([20, 20]);
  });

  it("REPEATABLE READ: locking a row changed since the snapshot fails with a retryable SERIALIZATION_FAILURE", async () => {
    const error = await adapter()
      .withTransaction(
        async () => {
          await items().findById(3);
          await other.getTable(fx.IgItem).updateOne({ id: 3, qty: 99 } as any);
          await items().findById(3, { lock: "update" });
        },
        { isolation: "repeatable read" },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({ code: "SERIALIZATION_FAILURE", retryable: true });
  });

  it("BEGIN ISOLATION LEVEL applies to its own transaction only", async () => {
    const level = () => (adapter() as any)._exec().get("SHOW transaction_isolation");
    const inTx = await adapter().withTransaction(level, { isolation: "serializable" });
    expect(inTx).toMatchObject({ transaction_isolation: "serializable" });
    const next = await adapter().withTransaction(level);
    expect(next).toMatchObject({ transaction_isolation: "read committed" });
  });
});
