import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vite-plus/test";
import { AtscriptDbTable, DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import {
  mysqlAdmin,
  mysqlReachable,
  mysqlDbUrl,
  recreateMysqlDatabase,
  dropMysqlDatabase,
} from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips
// otherwise (CI has no server). Override with `ATSCRIPT_MYSQL_TEST_URL` (an admin
// connection; the spec creates and drops its own `insert_ignore` database).
// Conflict-ignoring insert (since 0.1.148) + DbSpace.close() end to end.

const DB = "insert_ignore";

const reachable = await mysqlReachable();

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
    const driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(
      () => {
        const adapter = new MysqlAdapter(driver);
        adapter.setVerbose(true);
        return adapter;
      },
      { logger, onClose: () => driver.close() },
    );
    const result = await new SchemaSync(space).run(
      [fx.IgItem, fx.IgAuto, fx.IgNote, fx.IgRenamed],
      {
        force: true,
      },
    );
    expect(result.status).toBe("synced");
  });

  afterAll(async () => {
    await space?.close();
    await dropMysqlDatabase(DB);
  });

  const items = () => t(fx.IgItem);
  const ids = async () =>
    ((await items().findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[]).map(
      (r) => r.id,
    );

  beforeEach(async () => {
    await items().deleteMany({});
    await t(fx.IgAuto).deleteMany({});
    await t(fx.IgRenamed).deleteMany({});
    statements.length = 0;
  });

  it("a renamed @db.default.increment PK is AUTO_INCREMENT: inserts without an id work", async () => {
    const renamed = t(fx.IgRenamed);
    const a = await renamed.insertOne({ label: "a" });
    const b = await renamed.insertMany([{ label: "b" }, { label: "c" }]);
    const c = await renamed.insertMany([{ label: "d" }], { onConflict: "ignore" });
    expect(typeof a.insertedId).toBe("number");
    expect(new Set([a.insertedId, ...b.insertedIds, ...c.insertedIds]).size).toBe(4);
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

  it("mixed explicit and generated auto-increment PKs get their real ids (insertMany and ignore)", async () => {
    const auto = t(fx.IgAuto);
    const idsBySku = async () =>
      Object.fromEntries(
        ((await auto.findMany({ filter: {}, controls: {} })) as any[]).map((r) => [r.sku, r.id]),
      );
    const plain = await auto.insertMany([
      { sku: "g1", label: "gen" },
      { id: 100, sku: "e1", label: "explicit" },
      { sku: "g2", label: "gen" },
    ]);
    let stored = await idsBySku();
    expect(plain.insertedIds).toEqual([stored.g1, 100, stored.g2]);
    // g2 follows the explicit 100 in input order: the counter moved past it
    expect(stored.g2).toBeGreaterThan(100);

    const ignored = await auto.insertMany(
      [
        { sku: "g3", label: "gen" },
        { id: 200, sku: "e2", label: "explicit" },
        { sku: "g4", label: "gen" },
        { sku: "g1", label: "dup" },
      ],
      { onConflict: "ignore" },
    );
    stored = await idsBySku();
    expect(ignored.conflicts).toEqual([3]);
    expect(ignored.insertedIds).toEqual([stored.g3, 200, stored.g4]);
    expect(stored.g3).toBeGreaterThan(100);
  });

  it("a later explicit-id row never beats an earlier generated one on a case-insensitive unique value", async () => {
    const auto = t(fx.IgAuto);
    const result = await auto.insertMany(
      [
        { sku: "CiWins", label: "earlier, generated" },
        { id: 900, sku: "ciwins", label: "later, explicit" },
      ],
      { onConflict: "ignore" },
    );
    expect(result.conflicts).toEqual([1]);
    const rows = (await auto.findMany({ filter: { sku: "CiWins" }, controls: {} })) as any[];
    expect(rows.map((r) => r.label)).toEqual(["earlier, generated"]);
  });

  it("@@auto_increment_increment = 3: reported ids are the stored ids (insertMany and ignore)", async () => {
    const auto = t(fx.IgAuto);
    const stored = async () =>
      Object.fromEntries(
        ((await auto.findMany({ filter: {}, controls: {} })) as any[]).map((r) => [r.sku, r.id]),
      );
    await auto.dbAdapter.withTransaction(async () => {
      // session-scoped: this transaction's connection only, restored below
      const conn = (auto.dbAdapter as any)._exec();
      await conn.exec("SET SESSION auto_increment_increment = 3");
      try {
        const plain = await auto.insertMany([
          { sku: "i1", label: "a" },
          { sku: "i2", label: "b" },
          { sku: "i3", label: "c" },
        ]);
        const ignored = await auto.insertMany(
          [
            { sku: "i4", label: "d" },
            { sku: "i1", label: "dup" },
            { sku: "i5", label: "e" },
          ],
          { onConflict: "ignore" },
        );
        const ids = await stored();
        expect(plain.insertedIds).toEqual([ids.i1, ids.i2, ids.i3]);
        expect(ids.i2 - ids.i1).toBe(3);
        expect(ids.i3 - ids.i2).toBe(3);
        expect(ignored.conflicts).toEqual([1]);
        expect(ignored.insertedIds).toEqual([ids.i4, ids.i5]);
        expect(ids.i5 - ids.i4).toBe(3);
      } finally {
        await conn.exec("SET SESSION auto_increment_increment = 1");
      }
    });
  });

  it("@@auto_increment_increment = 3 as a server default, outside a transaction: ids are the stored ids", async () => {
    // GLOBAL applies to connections opened afterwards: a fresh pool sees stride 3 on every connection.
    // A managed server (RDS, Cloud SQL) refuses SET GLOBAL — stride 3 is then set on every connection
    // the pool opens, before the pool hands it out (the same per-connection state).
    const global = await mysqlAdmin("SET GLOBAL auto_increment_increment = 3");
    const pool = new Mysql2Driver(mysqlDbUrl(DB));
    if (!global) {
      type TRawConn = { query(sql: string, cb: () => void): unknown };
      const raw = (await (pool as any).poolInit) as {
        on(e: "connection", l: (c: TRawConn) => void): void;
      };
      raw.on(
        "connection",
        (conn) => void conn.query("SET SESSION auto_increment_increment = 3", () => {}),
      );
    }
    try {
      const auto = new AtscriptDbTable(fx.IgAuto, new MysqlAdapter(pool)) as any;
      expect(auto.dbAdapter.isInTransaction()).toBe(false);
      const res = await auto.insertMany([
        { sku: "o1", label: "a" },
        { sku: "o2", label: "b" },
        { sku: "o3", label: "c" },
      ]);
      const rows = (await auto.findMany({ filter: {}, controls: {} })) as any[];
      const id = (sku: string) => rows.find((r) => r.sku === sku).id;
      expect(res.insertedIds).toEqual([id("o1"), id("o2"), id("o3")]);
      expect(id("o2") - id("o1")).toBe(3);
    } finally {
      if (global) await mysqlAdmin("SET GLOBAL auto_increment_increment = 1");
      await pool.close();
    }
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

  it("an all-new batch is ONE statement", async () => {
    await items().insertMany(
      Array.from({ length: 50 }, (_, i) => item(i + 1, `n${i}`)),
      { onConflict: "ignore" },
    );
    expect(statements.filter((s) => /^(INSERT|SELECT)/.test(s))).toHaveLength(1);
  });

  it("a few duplicates: failed INSERT + SELECT + survivor INSERT, exact result", async () => {
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
    expect(statements.filter((s) => /^(INSERT|SELECT)/.test(s))).toHaveLength(3);
    expect(await items().count({ filter: {}, controls: {} })).toBe(64);
  });

  it("dense interleaved duplicates stay O(1) statements per chunk", async () => {
    await items().insertMany(Array.from({ length: 3000 }, (_, i) => item(2 * i + 1, `old${i}`)));
    statements.length = 0;
    const rows = Array.from({ length: 20000 }, (_, i) => item(i + 1, `n${i + 1}`));
    const result = await items().insertMany(rows, { onConflict: "ignore" });
    expect(result.insertedCount).toBe(17000);
    expect(result.conflicts).toHaveLength(3000);
    expect(statements.filter((s) => /^(INSERT|SELECT)/.test(s))).toHaveLength(3);
    expect(await items().count({ filter: {}, controls: {} })).toBe(20000);
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
