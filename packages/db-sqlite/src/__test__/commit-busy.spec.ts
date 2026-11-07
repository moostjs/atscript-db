import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { DbError } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { RecordingDriver } from "./test-utils";

/** Fails the next COMMIT like a busy database does: the statement does not run, the transaction stays open. */
class BusyCommitDriver extends RecordingDriver {
  failNextCommit: { code?: string; errcode?: number } | undefined;
  override exec(sql: string): void {
    if (this.failNextCommit && sql === "COMMIT") {
      const { code, errcode } = this.failNextCommit;
      this.failNextCommit = undefined;
      this.execs.push(sql);
      throw Object.assign(new Error("database is locked"), { code, errcode });
    }
    super.exec(sql);
  }
}

describe("[sqlite] COMMIT failure", () => {
  let driver: BusyCommitDriver;
  let adapter: SqliteAdapter;

  beforeEach(() => {
    driver = new BusyCommitDriver(new BetterSqlite3Driver(":memory:"));
    adapter = new SqliteAdapter(driver);
    driver.execs.length = 0; // the adapter's own PRAGMA
  });

  afterEach(() => driver.close());

  it.each([
    ["better-sqlite3", { code: "SQLITE_BUSY" }],
    ["node:sqlite", { errcode: 5 }],
  ])(
    "SQLITE_BUSY (%s) is a retryable LOCK_TIMEOUT with the driver error as cause",
    async (_n, shape) => {
      driver.failNextCommit = shape;
      const error = await adapter.withTransaction(async () => {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe("LOCK_TIMEOUT");
      expect((error as DbError).retryable).toBe(true);
      expect(((error as DbError).cause as Error).message).toBe("database is locked");
    },
  );

  it("the gate stays held until ROLLBACK: a queued transaction begins only after it", async () => {
    driver.failNextCommit = { code: "SQLITE_BUSY" };
    const first = adapter.withTransaction(async () => {}).catch((e: unknown) => e);
    const second = adapter.withTransaction(async () => "second");
    expect(await first).toBeInstanceOf(DbError);
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
    driver.failNextCommit = { code: "SQLITE_CONSTRAINT_FOREIGNKEY" };
    const error = await adapter.withTransaction(async () => {}).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(DbError);
    expect((error as Error).message).toBe("database is locked");
    expect(driver.execs.at(-1)).toBe("ROLLBACK");
  });
});
