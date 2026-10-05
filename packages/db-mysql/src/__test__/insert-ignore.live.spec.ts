import { describe, it, expect, beforeAll, beforeEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips
// otherwise (CI has no server). Override with `ATSCRIPT_MYSQL_TEST_URL` (an admin
// connection; the spec creates and drops its own `insert_ignore` database).
// Conflict-ignoring insert (since 0.1.148) + DbSpace.close() end to end.

const SERVER_URL = process.env.ATSCRIPT_MYSQL_TEST_URL ?? "mysql://root:test@127.0.0.1:33071";
const DB = "insert_ignore";

async function adminQuery(sql: string): Promise<boolean> {
  try {
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection({ uri: SERVER_URL, connectTimeout: 1500 });
    try {
      await conn.query(sql);
    } finally {
      await conn.end();
    }
    return true;
  } catch {
    return false;
  }
}

const reachable = await adminQuery("SELECT 1");

let fx: Record<string, any>;
let space: DbSpace;
/** Every statement the adapters log (debug level), for statement counting. */
const statements: string[] = [];
const logger = {
  error() {},
  warn() {},
  log() {},
  info() {},
  debug: (sql: unknown) => void statements.push(String(sql)),
};
const t = (type: unknown): any => space.getTable(type as never);
const item = (id: number, sku: string) => ({ id, sku, qty: 1 });

describe.skipIf(!reachable)("[mysql live] insert onConflict: ignore", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/insert-ignore.as");
    await adminQuery(`DROP DATABASE IF EXISTS \`${DB}\``);
    await adminQuery(`CREATE DATABASE \`${DB}\``);
    const driver = new Mysql2Driver(`${SERVER_URL}/${DB}`);
    space = new DbSpace(
      () => {
        const adapter = new MysqlAdapter(driver);
        adapter.setVerbose(true);
        return adapter;
      },
      { logger, onClose: () => driver.close() },
    );
    const result = await new SchemaSync(space).run([fx.IgItem, fx.IgAuto, fx.IgNote], {
      force: true,
    });
    expect(result.status).toBe("synced");
  });

  const items = () => t(fx.IgItem);
  const ids = async () =>
    ((await items().findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[]).map(
      (r) => r.id,
    );

  beforeEach(async () => {
    await items().deleteMany({});
    await t(fx.IgAuto).deleteMany({});
    statements.length = 0;
  });

  it("all-new, mixed and all-conflict batches", async () => {
    expect(
      await items().insertMany([item(1, "a"), item(2, "b")], { onConflict: "ignore" }),
    ).toEqual({ insertedCount: 2, insertedIds: [1, 2], inserted: [0, 1], conflicts: [] });
    const mixed = await items().insertMany([item(3, "c"), item(4, "a"), item(2, "z")], {
      onConflict: "ignore",
    });
    expect(mixed).toEqual({ insertedCount: 1, insertedIds: [3], inserted: [0], conflicts: [1, 2] });
    const none = await items().insertMany([item(1, "a")], { onConflict: "ignore" });
    expect(none.insertedCount).toBe(0);
    expect(await ids()).toEqual([1, 2, 3]);
  });

  it("generated PK + unique-index conflict", async () => {
    const auto = t(fx.IgAuto);
    await auto.insertOne({ sku: "s1", label: "one" });
    const result = await auto.insertMany(
      [
        { sku: "s1", label: "dup" },
        { sku: "s2", label: "two" },
      ],
      { onConflict: "ignore" },
    );
    expect(result.conflicts).toEqual([0]);
    const stored = await auto.findOne({ filter: { sku: "s2" }, controls: {} });
    expect(result.insertedIds).toEqual([stored.id]);
  });

  it("inside an outer transaction a skipped row never aborts it", async () => {
    await items().insertMany([item(1, "a")]);
    await items().dbAdapter.withTransaction(async () => {
      const result = await items().insertMany([item(2, "a"), item(3, "c")], {
        onConflict: "ignore",
      });
      expect(result.conflicts).toEqual([0]);
      await items().insertOne(item(4, "d"));
    });
    expect(await ids()).toEqual([1, 3, 4]);
  });

  it("bisects a chunk with a few duplicates: fewer statements than rows, exact result", async () => {
    await items().insertMany([item(1000, "dup1"), item(1001, "dup2")]);
    statements.length = 0;
    const rows = Array.from({ length: 64 }, (_, i) => item(i + 1, `s${i}`));
    rows[10] = item(11, "dup1");
    rows[40] = item(41, "dup2");
    const result = await items().insertMany(rows, { onConflict: "ignore" });
    expect(result.conflicts).toEqual([10, 40]);
    expect(result.insertedCount).toBe(62);
    expect(result.insertedIds).toEqual(
      rows.map((r) => r.id).filter((id) => id !== 11 && id !== 41),
    );
    const inserts = statements.filter((s) => s.startsWith("INSERT")).length;
    expect(inserts).toBeGreaterThan(1);
    expect(inserts).toBeLessThan(rows.length);
    expect(await items().count({ filter: {}, controls: {} })).toBe(64);
  });

  it("NOT NULL still raises", async () => {
    await expect(items().dbAdapter.insertManyIgnore([{ id: 9, sku: "n" }])).rejects.toBeTruthy();
    expect(await ids()).toEqual([]);
  });

  it("the default mode still throws CONFLICT", async () => {
    await items().insertMany([item(1, "a")]);
    await expect(items().insertMany([item(2, "a")])).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("DbSpace.close() ends the pool: handles reject with SPACE_CLOSED, close() is idempotent", async () => {
    const table = items();
    await space.close();
    await space.close();
    await expect(table.findMany({ filter: {}, controls: {} })).rejects.toMatchObject({
      code: "SPACE_CLOSED",
    });
  });
});
