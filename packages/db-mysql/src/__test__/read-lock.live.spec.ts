import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import {
  mysqlDbUrl,
  mysqlReachable,
  recreateMysqlDatabase,
  dropMysqlDatabase,
} from "./live-server";
import { defineReadLockCases, sleep } from "../../../db/test-kit/read-lock-cases";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// Server-gated (see insert-ignore-locking.live.spec.ts): locking reads and
// transaction isolation against a live MySQL 8 (since 0.1.162). Each
// `withTransaction` holds its own pooled connection, so two concurrent ones
// are two sessions.

const DB = "read_lock";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let space: DbSpace;
/** A second pool — its transactions are another owner's, so they never join one of `space`. */
let other: DbSpace;

describe.skipIf(!reachable)("[mysql live] locking reads and isolation", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/insert-ignore.as");
    const url = await recreateMysqlDatabase(DB);
    const driver = new Mysql2Driver(url);
    space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
    const otherDriver = new Mysql2Driver(url);
    other = new DbSpace(() => new MysqlAdapter(otherDriver), {
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
    await dropMysqlDatabase(DB);
  });

  const items = (): any => space.getTable(fx.IgItem);
  const codes = (): any => space.getTable(fx.IgCode);
  const notes = (): any => space.getTable(fx.IgNote);
  const adapter = (): MysqlAdapter => items().getAdapter();

  defineReadLockCases({
    items,
    notes,
    codes,
    skipLockedIsolations: ["read committed", "serializable"],
  });

  it("READ COMMITTED sees a change committed mid-transaction; the default REPEATABLE READ does not (but a locking read does)", async () => {
    // Committed by another session (autocommit on the second pool).
    const bump = (qty: number) => other.getTable(fx.IgItem).updateOne({ id: 2, qty } as any);
    const rc = await adapter().withTransaction(
      async () => {
        const before = ((await items().findById(2)) as any).qty;
        await bump(20);
        const after = ((await items().findById(2)) as any).qty;
        return [before, after];
      },
      { isolation: "read committed" },
    );
    expect(rc).toEqual([1, 20]);

    const rr = await adapter().withTransaction(async () => {
      const before = ((await items().findById(2)) as any).qty;
      await bump(30);
      const plain = ((await items().findById(2)) as any).qty;
      const locking = ((await items().findById(2, { lock: "share" })) as any).qty;
      return [before, plain, locking];
    });
    expect(rr).toEqual([20, 20, 30]);
  });

  it("SET TRANSACTION applies to the next transaction only — a reused pooled connection is back at the default", async () => {
    const driver = new Mysql2Driver({ uri: mysqlDbUrl(DB), connectionLimit: 1 });
    const single = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
    try {
      const table = single.getTable(fx.IgItem) as any;
      const a = table.getAdapter();
      const level = async () => {
        await table.findById(1); // starts the InnoDB transaction
        await sleep(250); // information_schema.innodb_trx is a cache refreshed every 100 ms
        const row = await a
          ._exec()
          .get(
            "SELECT trx_isolation_level AS level FROM information_schema.innodb_trx WHERE trx_mysql_thread_id = CONNECTION_ID()",
          );
        return row?.level;
      };
      expect(await a.withTransaction(level, { isolation: "serializable" })).toBe("SERIALIZABLE");
      expect(await a.withTransaction(level)).toBe("REPEATABLE READ");
      expect(await a.withTransaction(level, { isolation: "read committed" })).toBe(
        "READ COMMITTED",
      );
      expect(await a.withTransaction(level)).toBe("REPEATABLE READ");
    } finally {
      await single.close();
    }
  });
});
