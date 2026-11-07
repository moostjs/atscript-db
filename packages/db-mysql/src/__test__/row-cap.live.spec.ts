import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vite-plus/test";
import { DbError, DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";
import { signal, sleep } from "../../../db/test-kit/read-lock-cases";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// Server-gated: the row-cap recipe of the docs ("At most N rows per parent").
// Under REPEATABLE READ a count taken after the write sees the transaction's
// own row and none of a concurrent one, so two inserts that each count one row
// both pass a cap of one. Locking the parent row first and counting after
// serialises them — but only when the lock is the transaction's FIRST read: the
// first plain read fixes InnoDB's snapshot, and a count after the lock then
// misses what the other transaction committed meanwhile. Each insert runs in
// its own transaction on its own pooled connection.

const DB = "row_cap";
const CAP = 1;

const reachable = await mysqlReachable();

const capError = () => new DbError("CONFLICT", [{ path: "householdId", message: "Cap reached" }]);

let fx: Record<string, any>;
let space: DbSpace;

describe.skipIf(!reachable)("[mysql live] a row cap per parent", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/row-cap.as");
    const driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
    const result = await new SchemaSync(space).run([fx.RcHousehold, fx.RcItem], { force: true });
    expect(result.status).toBe("synced");
  });

  afterAll(async () => {
    await space?.close();
    await dropMysqlDatabase(DB);
  });

  const households = (): any => space.getTable(fx.RcHousehold);
  const items = (): any => space.getTable(fx.RcItem);

  beforeEach(async () => {
    await items().deleteMany({});
    await households().deleteMany({});
    await households().insertOne({ id: 1, name: "h" });
  });

  it("a count after the write (check) races: two concurrent inserts both pass a cap of one", async () => {
    // Both rows are written before either transaction counts.
    let arrived = 0;
    const both = signal();
    const check = async () => {
      if (++arrived === 2) both.fire();
      await both.wait;
      const n = await items().count({ filter: { householdId: 1 }, controls: {} });
      if (n > CAP) throw capError();
    };
    const results = await Promise.allSettled([
      items().insertOne({ id: 1, householdId: 1, name: "a" }, { check }),
      items().insertOne({ id: 2, householdId: 1, name: "b" }, { check }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    // The cap is broken: each count saw its own row only.
    expect(await items().count({ filter: { householdId: 1 }, controls: {} })).toBe(2);
  });

  it("locking the parent, then counting (guard) holds the cap", async () => {
    const firstCounted = signal();
    const order: string[] = [];
    const guard = (name: string) => async (ctx: any) => {
      const row = ctx.rows[0];
      // Every insert for this household waits here for the one before it to commit.
      await households().findById(row.householdId, { lock: "update" });
      order.push(`${name} locked`);
      const n = await items().count({ filter: { householdId: row.householdId }, controls: {} });
      if (n + ctx.rows.length > CAP) throw capError();
      if (name === "first") {
        firstCounted.fire();
        await sleep(300); // the second insert is blocked on the lock meanwhile
      }
    };
    const first = items().insertOne(
      { id: 1, householdId: 1, name: "a" },
      { guard: guard("first") },
    );
    await firstCounted.wait;
    const second = items()
      .insertOne({ id: 2, householdId: 1, name: "b" }, { guard: guard("second") })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await first;
    const error = await second;
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("CONFLICT");
    expect(order).toEqual(["first locked", "second locked"]);
    expect(await items().count({ filter: { householdId: 1 }, controls: {} })).toBe(1);
  });

  it("a plain read before the lock fixes the snapshot: the count after the lock misses the committed row", async () => {
    const firstCounted = signal();
    const guard = (name: string) => async (ctx: any) => {
      const row = ctx.rows[0];
      // The second insert reads first (the snapshot is fixed here) ...
      if (name === "second") await items().findMany({ filter: {}, controls: {} });
      await households().findById(row.householdId, { lock: "update" });
      // ... and counts from that snapshot after the first insert committed.
      const n = await items().count({ filter: { householdId: row.householdId }, controls: {} });
      if (n + ctx.rows.length > CAP) throw capError();
      if (name === "first") {
        firstCounted.fire();
        await sleep(300);
      }
    };
    const first = items().insertOne(
      { id: 1, householdId: 1, name: "a" },
      { guard: guard("first") },
    );
    await firstCounted.wait;
    await Promise.all([
      first,
      items().insertOne({ id: 2, householdId: 1, name: "b" }, { guard: guard("second") }),
    ]);
    // The cap is broken although the parent was locked: the read came first.
    expect(await items().count({ filter: { householdId: 1 }, controls: {} })).toBe(2);
  });

  it("serializable isolation with a retry holds the cap too", async () => {
    const adapter = items().getAdapter() as MysqlAdapter;
    let arrived = 0;
    const both = signal();
    const insert = async (id: number) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await adapter.withTransaction(
            async () => {
              const n = await items().count({ filter: { householdId: 1 }, controls: {} });
              if (attempt === 0 && ++arrived === 2) both.fire();
              if (attempt === 0) await both.wait; // both read before either writes
              if (n >= CAP) throw capError();
              await items().insertOne({ id, householdId: 1, name: String(id) });
            },
            { isolation: "serializable" },
          );
        } catch (error) {
          if (error instanceof DbError && error.retryable && attempt < 3) continue;
          throw error;
        }
      }
    };
    const results = await Promise.allSettled([insert(1), insert(2)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as DbError).code).toBe("CONFLICT");
    expect(await items().count({ filter: { householdId: 1 }, controls: {} })).toBe(1);
  });
});
