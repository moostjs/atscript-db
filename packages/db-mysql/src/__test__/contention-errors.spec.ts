import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbError, DbSpace } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { caught, createMockDriver, prepareFixtures } from "./test-utils";

// A deadlock (1213) or lock wait timeout (1205) can fail the COMMIT itself or
// a plain read inside the transaction; both reject with the retryable
// `DbError` (a caller's retry loop keys on `retryable`), not the raw driver
// error.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/constraint-errors.as");
});

const mysqlError = (errno: number) =>
  Object.assign(new Error(`mysql ${errno}`), { errno, sqlMessage: `mysql ${errno}` });

function setup(overrides?: Parameters<typeof createMockDriver>[0] & { readError?: Error }) {
  const driver = createMockDriver(overrides);
  const { readError } = overrides ?? {};
  if (readError) {
    // every read statement (pool or dedicated connection) fails
    const failGet = async () => {
      throw readError;
    };
    driver.get = failGet as never;
    const getConnection = driver.getConnection.bind(driver);
    driver.getConnection = async () => ({ ...(await getConnection()), get: failGet as never });
  }
  const space = new DbSpace(() => new MysqlAdapter(driver));
  const table: any = space.getTable(fx.CeItem as never);
  return { driver, table, adapter: table.dbAdapter as MysqlAdapter };
}

const timeout = () =>
  Object.assign(new Error("Query inactivity timeout"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" });

/** A column diff adding `code` (one `ALTER TABLE … ADD COLUMN`). */
const addColumn = (table: any) => ({
  added: [table.fieldDescriptors.find((f: any) => f.path === "code")],
  renamed: [],
  typeChanged: [],
  nullableChanged: [],
  defaultChanged: [],
});

/** An `execError` failing exactly the statements named. */
const failOn = (failures: Record<string, Error>) => (sql: string) => failures[sql];

const OFF = "SET FOREIGN_KEY_CHECKS = 0";
const ON = "SET FOREIGN_KEY_CHECKS = 1";

/** Every statement the mock driver ran, as `<pool|conn>:<sql>`. */
const sqls = (driver: ReturnType<typeof createMockDriver>) =>
  driver.calls.map((c) => `${c.via}:${c.sql}`);

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe("[mysql] contention errors", () => {
  it.each([
    [1213, "DEADLOCK"],
    [1205, "LOCK_TIMEOUT"],
    [3572, "LOCK_TIMEOUT"],
  ])("errno %i raised at COMMIT is the retryable %s", async (errno, mapped) => {
    const raw = mysqlError(errno);
    const { driver, adapter } = setup({
      execError: (sql) => (sql === "COMMIT" ? raw : undefined),
    });
    const error = await rejection(adapter.withTransaction(async () => {}));
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe(mapped);
    expect((error as DbError).retryable).toBe(true);
    expect((error as DbError).cause).toBe(raw);
    // the failed COMMIT already ended the transaction: no ROLLBACK, one release
    expect(driver.calls.map((c) => c.sql)).toEqual(["START TRANSACTION", "COMMIT"]);
    expect(driver.releaseCount()).toBe(1);
    expect(driver.destroyCount()).toBe(0);
  });

  it("a non-contention COMMIT failure passes through unchanged", async () => {
    const boom = mysqlError(1105);
    const { adapter } = setup({ execError: (sql) => (sql === "COMMIT" ? boom : undefined) });
    expect(await rejection(adapter.withTransaction(async () => {}))).toBe(boom);
  });

  it("1213 on a plain read inside the transaction is retryable", async () => {
    const { driver, table, adapter } = setup({ readError: mysqlError(1213) });
    const error = await rejection(
      adapter.withTransaction(() => table.count({ filter: {}, controls: {} })),
    );
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("DEADLOCK");
    expect((error as DbError).retryable).toBe(true);
    expect(driver.releaseCount()).toBe(1);
  });

  it("1205 on a plain read outside a transaction is retryable", async () => {
    const { table } = setup({ readError: mysqlError(1205) });
    const error = await rejection(table.count({ filter: {}, controls: {} }));
    expect((error as DbError).code).toBe("LOCK_TIMEOUT");
  });

  it("a failed COMMIT does not poison the next transaction on the same connection object", async () => {
    let failCommit = true;
    const { driver, adapter } = setup({
      reuseConnection: true,
      execError: (sql) => {
        if (sql === "COMMIT" && failCommit) {
          failCommit = false;
          return mysqlError(1213);
        }
        return undefined;
      },
    });
    await rejection(adapter.withTransaction(async () => {}));
    const boom = new Error("boom");
    expect(
      await rejection(
        adapter.withTransaction(async () => {
          throw boom;
        }),
      ),
    ).toBe(boom);
    expect(driver.calls.map((c) => c.sql)).toEqual([
      "START TRANSACTION",
      "COMMIT",
      "START TRANSACTION",
      "ROLLBACK",
    ]);
    expect(driver.releaseCount()).toBe(2);
  });

  it("a successful COMMIT leaves no mark: a later failed transaction on the same connection rolls back and releases", async () => {
    const { driver, adapter } = setup({ reuseConnection: true });
    await adapter.withTransaction(async () => {});
    const boom = new Error("boom");
    await rejection(
      adapter.withTransaction(async () => {
        throw boom;
      }),
    );
    expect(driver.calls.map((c) => c.sql)).toEqual([
      "START TRANSACTION",
      "COMMIT",
      "START TRANSACTION",
      "ROLLBACK",
    ]);
    expect(driver.releaseCount()).toBe(2);
  });

  // Since 0.1.178: schema steps that take their own connection (the strict
  // session of `syncColumns` / `recreateTable`, `dropTableByName`) map
  // contention too — a metadata lock on ALTER / DROP used to reach the caller
  // as the raw driver error. The session restores still run, the connection
  // is still released.
  describe("schema steps on their own connection", () => {
    it("1205 inside syncColumns (strict session) is the retryable LOCK_TIMEOUT; sql_mode restored, released", async () => {
      const raw = mysqlError(1205);
      const { driver, table, adapter } = setup({
        execError: (sql) => (sql.includes("ADD COLUMN") ? raw : undefined),
      });
      const error = await caught(adapter.syncColumns(addColumn(table) as any));
      expect(error.code).toBe("LOCK_TIMEOUT");
      expect(error.retryable).toBe(true);
      expect(error.cause).toBe(raw);
      const calls = sqls(driver);
      expect(calls.at(-2)).toMatch(/^conn:ALTER TABLE .* ADD COLUMN/);
      expect(calls.at(-1)).toBe("conn:SET SESSION sql_mode = @atscript_sql_mode");
      expect(driver.releaseCount()).toBe(1);
    });

    it("1213 inside syncColumns on the transaction's connection is the retryable DEADLOCK", async () => {
      const raw = mysqlError(1213);
      const { driver, table, adapter } = setup({
        execError: (sql) => (sql.includes("ADD COLUMN") ? raw : undefined),
      });
      const error = await caught(
        adapter.withTransaction(() => adapter.syncColumns(addColumn(table) as any)),
      );
      expect(error.code).toBe("DEADLOCK");
      expect(error.cause).toBe(raw);
      expect(sqls(driver).slice(-2)).toEqual([
        "conn:SET SESSION sql_mode = @atscript_sql_mode",
        "conn:ROLLBACK",
      ]);
      expect(driver.releaseCount()).toBe(1);
    });

    it("1205 inside recreateTable is LOCK_TIMEOUT; FK checks and sql_mode restored, released", async () => {
      const raw = mysqlError(1205);
      const { driver, adapter } = setup({
        execError: (sql) => (sql.startsWith("CREATE TABLE") ? raw : undefined),
      });
      const error = await caught(adapter.recreateTable());
      expect(error.code).toBe("LOCK_TIMEOUT");
      expect(error.cause).toBe(raw);
      expect(sqls(driver).slice(-2)).toEqual([
        "conn:SET FOREIGN_KEY_CHECKS = 1",
        "conn:SET SESSION sql_mode = @atscript_sql_mode",
      ]);
      expect(driver.releaseCount()).toBe(1);
    });

    it("1205 inside dropTableByName is LOCK_TIMEOUT; FK checks restored, released", async () => {
      const raw = mysqlError(1205);
      const { driver, adapter } = setup({
        execError: (sql) => (sql.startsWith("DROP TABLE") ? raw : undefined),
      });
      const error = await caught(adapter.dropTableByName("ce_items"));
      expect(error.code).toBe("LOCK_TIMEOUT");
      expect(error.retryable).toBe(true);
      expect(error.cause).toBe(raw);
      expect(sqls(driver)).toEqual([
        "conn:SET FOREIGN_KEY_CHECKS = 0",
        "conn:DROP TABLE IF EXISTS `ce_items`",
        "conn:SET FOREIGN_KEY_CHECKS = 1",
      ]);
      expect(driver.releaseCount()).toBe(1);
    });

    it("a non-contention failure surfaces unchanged (syncColumns, dropTableByName)", async () => {
      const boom = mysqlError(1105);
      const { driver, table, adapter } = setup({
        execError: (sql) =>
          sql.includes("ADD COLUMN") || sql.startsWith("DROP TABLE") ? boom : undefined,
      });
      expect(await rejection(adapter.syncColumns(addColumn(table) as any))).toBe(boom);
      expect(await rejection(adapter.dropTableByName("ce_items"))).toBe(boom);
      expect(driver.releaseCount()).toBe(2);
    });
  });

  // Since 0.1.178 `dropTableByName` hands its connection back on every
  // failure: a failing `SET FOREIGN_KEY_CHECKS = 0` leaked it (it ran outside
  // the try), and so did a failing restore (the release came after it).
  describe("dropTableByName hands the connection back on every failure", () => {
    const DROP = "DROP TABLE IF EXISTS `ce_items`";

    it("a failing SET … = 0: mapped, the restore still runs, released exactly once", async () => {
      const raw = mysqlError(1205);
      const { driver, adapter } = setup({ execError: failOn({ [OFF]: raw }) });
      const error = await caught(adapter.dropTableByName("ce_items"));
      expect(error.code).toBe("LOCK_TIMEOUT");
      expect(error.cause).toBe(raw);
      expect(sqls(driver)).toEqual([`conn:${OFF}`, `conn:${ON}`]);
      expect(driver.releaseCount()).toBe(1);
      expect(driver.destroyCount()).toBe(0);
    });

    it("a failing restore after the DROP: its error, the session closed — not handed to the pool", async () => {
      const raw = mysqlError(1205);
      const { driver, adapter } = setup({ execError: failOn({ [ON]: raw }) });
      const error = await caught(adapter.dropTableByName("ce_items"));
      expect(error.code).toBe("LOCK_TIMEOUT");
      expect(error.cause).toBe(raw);
      expect(sqls(driver)).toEqual([`conn:${OFF}`, `conn:${DROP}`, `conn:${ON}`]);
      expect(driver.destroyCount()).toBe(1);
      expect(driver.releaseCount()).toBe(0);
    });

    it("the DROP and the restore both failing: the DROP's error wins", async () => {
      const drop = mysqlError(1213);
      const { driver, adapter } = setup({
        execError: failOn({ [DROP]: drop, [ON]: timeout() }),
      });
      const error = await caught(adapter.dropTableByName("ce_items"));
      expect(error.code).toBe("DEADLOCK");
      expect(error.cause).toBe(drop);
      expect(driver.destroyCount()).toBe(1);
      expect(driver.releaseCount()).toBe(0);
    });

    it("a driver without destroy(): a failing restore releases the connection once", async () => {
      const boom = mysqlError(1105);
      const { driver, adapter } = setup({ destroyable: false, execError: failOn({ [ON]: boom }) });
      expect(await rejection(adapter.dropTableByName("ce_items"))).toBe(boom);
      expect(driver.releaseCount()).toBe(1);
    });
  });

  // Since 0.1.180 a strict-session step or a recreate that cannot put its
  // session setting back closes the connection: before, it returned to the
  // pool still in the changed `sql_mode`, or with foreign-key checks off for
  // the next borrower. The step's own error still wins over the restore's.
  describe("a session setting that cannot be restored closes the connection", () => {
    const MODE = "SET SESSION sql_mode = @atscript_sql_mode";

    it("syncColumns: a failing sql_mode restore is the error; closed, not released", async () => {
      const boom = mysqlError(1105);
      const { driver, table, adapter } = setup({ execError: failOn({ [MODE]: boom }) });
      expect(await rejection(adapter.syncColumns(addColumn(table) as any))).toBe(boom);
      expect(driver.destroyCount()).toBe(1);
      expect(driver.releaseCount()).toBe(0);
    });

    it("syncColumns: the step and the restore both failing — the step's error wins; closed", async () => {
      const step = mysqlError(1213);
      const { driver, table, adapter } = setup({
        execError: (sql) =>
          sql.includes("ADD COLUMN") ? step : sql === MODE ? timeout() : undefined,
      });
      const error = await caught(adapter.syncColumns(addColumn(table) as any));
      expect(error.code).toBe("DEADLOCK");
      expect(error.cause).toBe(step);
      expect(driver.destroyCount()).toBe(1);
      expect(driver.releaseCount()).toBe(0);
    });

    it("recreateTable: a failing FOREIGN_KEY_CHECKS restore — sql_mode is still restored; closed", async () => {
      const boom = mysqlError(1105);
      const { driver, adapter } = setup({ execError: failOn({ [ON]: boom }) });
      expect(await rejection(adapter.recreateTable())).toBe(boom);
      expect(sqls(driver).slice(-2)).toEqual([`conn:${ON}`, `conn:${MODE}`]);
      expect(driver.destroyCount()).toBe(1);
      expect(driver.releaseCount()).toBe(0);
    });

    it("recreateTable: the copy and the FK restore both failing — the copy's error wins; closed", async () => {
      const create = mysqlError(1205);
      const { driver, adapter } = setup({
        execError: (sql) =>
          sql.startsWith("CREATE TABLE") ? create : sql === ON ? timeout() : undefined,
      });
      const error = await caught(adapter.recreateTable());
      expect(error.code).toBe("LOCK_TIMEOUT");
      expect(error.cause).toBe(create);
      expect(driver.destroyCount()).toBe(1);
      expect(driver.releaseCount()).toBe(0);
    });

    it("on a transaction's connection: closed when the transaction ends, after its ROLLBACK", async () => {
      const boom = mysqlError(1105);
      const { driver, table, adapter } = setup({ execError: failOn({ [MODE]: boom }) });
      expect(
        await rejection(
          adapter.withTransaction(() => adapter.syncColumns(addColumn(table) as any)),
        ),
      ).toBe(boom);
      expect(sqls(driver).slice(-2)).toEqual([`conn:${MODE}`, "conn:ROLLBACK"]);
      expect(driver.destroyCount()).toBe(1);
      expect(driver.releaseCount()).toBe(0);
    });

    it("on a transaction's connection that commits: closed after the COMMIT", async () => {
      const { driver, table, adapter } = setup({ execError: failOn({ [MODE]: mysqlError(1105) }) });
      await adapter.withTransaction(async () => {
        await rejection(adapter.syncColumns(addColumn(table) as any));
      });
      expect(sqls(driver).at(-1)).toBe("conn:COMMIT");
      expect(driver.destroyCount()).toBe(1);
      expect(driver.releaseCount()).toBe(0);
    });

    it("a restore that succeeds leaves the connection pooled (syncColumns, recreateTable)", async () => {
      const { driver, table, adapter } = setup();
      await adapter.syncColumns(addColumn(table) as any);
      await adapter.recreateTable();
      expect(driver.destroyCount()).toBe(0);
      expect(driver.releaseCount()).toBe(2);
    });

    it("a driver without destroy(): the connection is released once", async () => {
      const boom = mysqlError(1105);
      const { driver, table, adapter } = setup({
        destroyable: false,
        execError: failOn({ [MODE]: boom }),
      });
      expect(await rejection(adapter.syncColumns(addColumn(table) as any))).toBe(boom);
      expect(driver.releaseCount()).toBe(1);
    });
  });

  describe("a COMMIT that fails on the client (no server errno)", () => {
    it("discards the connection and sends no ROLLBACK", async () => {
      const raw = timeout();
      const { driver, adapter } = setup({
        execError: (sql) => (sql === "COMMIT" ? raw : undefined),
      });
      expect(await rejection(adapter.withTransaction(async () => {}))).toBe(raw);
      expect(driver.destroyCount()).toBe(1);
      expect(driver.releaseCount()).toBe(0);
      expect(driver.calls.map((c) => c.sql)).toEqual(["START TRANSACTION", "COMMIT"]);
    });

    it("a driver without destroy() gets a best-effort ROLLBACK, then release", async () => {
      const raw = timeout();
      const { driver, adapter } = setup({
        destroyable: false,
        execError: (sql) => (sql === "COMMIT" ? raw : undefined),
      });
      expect(await rejection(adapter.withTransaction(async () => {}))).toBe(raw);
      expect(driver.releaseCount()).toBe(1);
      expect(driver.calls.map((c) => c.sql)).toEqual(["START TRANSACTION", "COMMIT", "ROLLBACK"]);
    });
  });
});
