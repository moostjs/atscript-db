import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { AtscriptDbTable, DbError } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures, RecordingDriver } from "./test-utils";

// Populated after fixtures compile.
let VersionedUserTable: any;
let VersionedLineTable: any;

/** Records every `run` statement so UPDATE chunking is observable. */
class RunRecordingDriver extends RecordingDriver {
  readonly runs: Array<{ sql: string; params?: unknown[] }> = [];
  override run(sql: string, params?: unknown[]) {
    this.runs.push({ sql, params });
    return super.run(sql, params);
  }
}

/**
 * `touchMany` end-to-end on SQLite (since 0.1.129): the bumps are real
 * `UPDATE … SET "version" = "version" + 1 WHERE (("id" = ? AND "version" = ?) OR …)`
 * statements inside one transaction, so a mismatch detected after the write
 * rolls every bump back.
 */
describe("touchMany via SqliteAdapter + AtscriptDbTable", () => {
  let driver: RunRecordingDriver;
  let adapter: SqliteAdapter;
  let users: AtscriptDbTable;
  let lines: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/version-occ.as");
    VersionedUserTable = fixtures.VersionedUserTable;
    VersionedLineTable = fixtures.VersionedLineTable;
  });

  beforeEach(async () => {
    driver = new RunRecordingDriver(new BetterSqlite3Driver(":memory:"));
    adapter = new SqliteAdapter(driver);
    users = new AtscriptDbTable(VersionedUserTable, adapter);
    lines = new AtscriptDbTable(VersionedLineTable, new SqliteAdapter(driver));
    await users.ensureTable();
    await lines.ensureTable();
    await users.insertMany([
      { id: 1, name: "Ada", status: "active", counter: 0 },
      { id: 2, name: "Bob", status: "active", counter: 0 },
      { id: 3, name: "Cy", status: "active", counter: 0 },
    ] as any);
    // Move versions apart so a bump is distinguishable per row.
    await users.updateOne({ id: 3, counter: 1 } as any); // version 1
    await users.updateOne({ id: 3, counter: 2 } as any); // version 2
    driver.runs.length = 0;
  });

  afterEach(() => {
    driver.close();
  });

  const versions = async () =>
    ((await users.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[]).map(
      (r) => r.version,
    );
  const updates = () => driver.runs.filter((r) => r.sql.startsWith("UPDATE"));

  it("full match bumps every version by exactly 1 and reports { m, m }", async () => {
    const result = await users.touchMany([
      { id: 1, version: 0 },
      { id: 2, version: 0 },
      { id: 3, version: 2 },
    ] as any);
    expect(result).toEqual({ matchedCount: 3, modifiedCount: 3 });
    expect(await versions()).toEqual([1, 1, 3]);

    const [stmt] = updates();
    expect(updates()).toHaveLength(1);
    expect(stmt!.sql).toBe(
      // AND binds tighter than OR: one (pk AND version) group per key.
      'UPDATE "versioned_users" SET "version" = "version" + 1 WHERE ("id" = ? AND "version" = ? OR "id" = ? AND "version" = ? OR "id" = ? AND "version" = ?)',
    );
    expect(stmt!.params).toEqual([1, 0, 2, 0, 3, 2]);
  });

  it("one stale key → CAS_MISMATCH from the pre-count; no UPDATE runs, no version moves", async () => {
    const err = await users
      .touchMany([
        { id: 1, version: 0 },
        { id: 2, version: 5 },
        { id: 3, version: 2 },
      ] as any)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("CAS_MISMATCH");
    expect((err as DbError).message).toBe("touchMany: 2 of 3 rows matched — stale or missing rows");
    expect(updates()).toHaveLength(0);
    expect(await versions()).toEqual([0, 0, 2]);
  });

  it("a mismatch detected after the write rolls the whole batch back (transaction)", async () => {
    // Force the pre-count to pass so the in-transaction check is what fires.
    vi.spyOn(adapter, "count").mockResolvedValue(3);
    const err = await users
      .touchMany([
        { id: 1, version: 0 },
        { id: 2, version: 5 }, // stale
        { id: 3, version: 2 },
      ] as any)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("CAS_MISMATCH");
    // The UPDATE ran (bumping rows 1 and 3) and the ROLLBACK undid it.
    expect(updates()).toHaveLength(1);
    expect(driver.execs.some((s) => s.startsWith("ROLLBACK"))).toBe(true);
    expect(await versions()).toEqual([0, 0, 2]);
  });

  it("require: 'any' bumps what matches and reports the partial result", async () => {
    const result = await users.touchMany(
      [
        { id: 1, version: 0 },
        { id: 2, version: 5 },
        { id: 3, version: 2 },
      ] as any,
      { require: "any" },
    );
    expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
    expect(await versions()).toEqual([1, 0, 3]);
  });

  it("600 keys → two UPDATE statements (500 + 100) inside one BEGIN/COMMIT", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({
      id: 100 + i,
      name: `u${i}`,
      status: "x",
      counter: 0,
    }));
    await users.insertMany(rows as any);
    driver.runs.length = 0;
    driver.execs.length = 0;

    const result = await users.touchMany(rows.map((r) => ({ id: r.id, version: 0 })) as any);
    expect(result).toEqual({ matchedCount: 600, modifiedCount: 600 });
    expect(updates()).toHaveLength(2);
    expect(updates()[0]!.params).toHaveLength(1000);
    expect(updates()[1]!.params).toHaveLength(200);
    expect(driver.execs.filter((s) => s.startsWith("BEGIN"))).toHaveLength(1);
    expect(driver.execs.filter((s) => s.startsWith("COMMIT"))).toHaveLength(1);
    const bumped = (await users.findMany({
      filter: { id: { $gte: 100 } },
      controls: {},
    })) as any[];
    expect(bumped).toHaveLength(600);
    expect(bumped.every((r) => r.version === 1)).toBe(true);
  });

  it("an outer withTransaction that throws undoes the touch", async () => {
    await expect(
      adapter.withTransaction(async () => {
        const r = await users.touchMany([
          { id: 1, version: 0 },
          { id: 2, version: 0 },
        ] as any);
        expect(r).toEqual({ matchedCount: 2, modifiedCount: 2 });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await versions()).toEqual([0, 0, 2]);
  });

  it("composite primary key", async () => {
    await lines.insertMany([
      { orderId: 1, lineNo: 1, qty: 2 },
      { orderId: 1, lineNo: 2, qty: 3 },
      { orderId: 2, lineNo: 1, qty: 4 },
    ] as any);
    driver.runs.length = 0;
    const result = await lines.touchMany([
      { orderId: 1, lineNo: 2, version: 0 },
      { orderId: 2, lineNo: 1, version: 0 },
    ] as any);
    expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
    expect(updates()[0]!.sql).toContain(
      'WHERE ("orderId" = ? AND "lineNo" = ? AND "version" = ? OR "orderId" = ? AND "lineNo" = ? AND "version" = ?)',
    );
    const all = (await lines.findMany({
      filter: {},
      controls: { $sort: { orderId: 1, lineNo: 1 } },
    })) as any[];
    expect(all.map((r) => r.version)).toEqual([0, 1, 1]);
  });
});
