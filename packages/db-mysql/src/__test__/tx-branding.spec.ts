import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { AtscriptDbTable, BaseDbAdapter } from "@atscript/db";
import type {
  DbQuery,
  FilterExpr,
  TDbDeleteResult,
  TDbInsertManyResult,
  TDbInsertResult,
  TDbUpdateResult,
} from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

let VersionedItemTable: any;

/**
 * A foreign adapter whose transaction state is SHAPED like a pooled connection
 * (every method present) but must never be used as one: since 0.1.128 the
 * core brands transaction state by owner, so MySQL ignores it regardless of
 * shape and runs through its own pool / connection.
 */
class TrapState {
  readonly used: string[] = [];
  run = async (sql: string) => this.trip(sql);
  all = async (sql: string) => this.trip(sql);
  get = async (sql: string) => this.trip(sql);
  exec = async (sql: string) => this.trip(sql);
  release = () => this.trip("release");
  private trip(sql: string): never {
    this.used.push(sql);
    throw new Error(`foreign transaction state used as a MySQL connection: ${sql}`);
  }
}

class ForeignAdapter extends BaseDbAdapter {
  readonly trap = new TrapState();
  protected override async _beginTransaction(): Promise<unknown> {
    return this.trap;
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

describe("MysqlAdapter — transaction state is branded by pool (since 0.1.128)", () => {
  let driver: ReturnType<typeof createMockDriver>;
  let adapter: MysqlAdapter;
  let table: AtscriptDbTable;
  let foreign: ForeignAdapter;

  beforeAll(async () => {
    await prepareFixtures();
    VersionedItemTable = (await import("./fixtures/version-occ.as")).VersionedItemTable;
  });

  beforeEach(() => {
    driver = createMockDriver({ getResult: { cnt: 1 } });
    adapter = new MysqlAdapter(driver);
    table = new AtscriptDbTable(VersionedItemTable, adapter);
    foreign = new ForeignAdapter();
    new AtscriptDbTable(VersionedItemTable, foreign);
  });

  const sqls = () => driver.calls.map((c) => c.sql);

  it("a bare statement inside a foreign-outer transaction runs autocommit through the pool, never on the foreign state", async () => {
    await foreign.withTransaction(async () => {
      await table.findOne({ filter: { id: 1 }, controls: {} });
      await table.count({ filter: {}, controls: {} });
    });
    expect(foreign.trap.used).toEqual([]);
    expect(sqls().some((s) => s.startsWith("SELECT"))).toBe(true);
    expect(sqls()).not.toContain("START TRANSACTION");
  });

  it("a table write inside a foreign-outer transaction opens its own transaction (the table wraps writes), never on the foreign state", async () => {
    await foreign.withTransaction(async () => {
      await table.insertOne({ id: 1, name: "a" } as any);
    });
    expect(foreign.trap.used).toEqual([]);
    const tx = sqls().filter((s) => /^(START TRANSACTION|COMMIT|ROLLBACK)$/.test(s));
    expect(tx).toEqual(["START TRANSACTION", "COMMIT"]);
    expect(sqls().some((s) => s.startsWith("INSERT"))).toBe(true);
  });

  it("a nested withTransaction inside a foreign-outer context opens its own MySQL transaction on a pool connection", async () => {
    await foreign.withTransaction(async () => {
      await adapter.withTransaction(async () => {
        await table.insertOne({ id: 1, name: "a" } as any);
      });
    });
    expect(foreign.trap.used).toEqual([]);
    const tx = sqls().filter((s) => /^(START TRANSACTION|COMMIT|ROLLBACK)$/.test(s));
    expect(tx).toEqual(["START TRANSACTION", "COMMIT"]);
  });

  it("recreateTable inside a foreign-outer transaction takes its own dedicated connection", async () => {
    await foreign.withTransaction(async () => {
      await adapter.recreateTable();
    });
    expect(foreign.trap.used).toEqual([]);
    expect(sqls().some((s) => s.includes("FOREIGN_KEY_CHECKS = 0"))).toBe(true);
    expect(sqls().some((s) => s.includes("FOREIGN_KEY_CHECKS = 1"))).toBe(true);
  });

  it("two adapters over the same pool join one transaction; a second pool does not", async () => {
    const sibling = new AtscriptDbTable(VersionedItemTable, new MysqlAdapter(driver));
    const otherDriver = createMockDriver({ getResult: { cnt: 1 } });
    const otherPool = new AtscriptDbTable(VersionedItemTable, new MysqlAdapter(otherDriver));
    await adapter.withTransaction(async () => {
      await table.insertOne({ id: 1, name: "a" } as any);
      await sibling.insertOne({ id: 2, name: "b" } as any);
      await otherPool.insertOne({ id: 3, name: "c" } as any);
    });
    const tx = sqls().filter((s) => /^(START TRANSACTION|COMMIT)$/.test(s));
    expect(tx).toEqual(["START TRANSACTION", "COMMIT"]); // one transaction for both tables
    // The other pool is a different owner: its table write opened its OWN transaction there.
    const otherTx = otherDriver.calls
      .map((c) => c.sql)
      .filter((s) => /^(START TRANSACTION|COMMIT)$/.test(s));
    expect(otherTx).toEqual(["START TRANSACTION", "COMMIT"]);
  });
});
