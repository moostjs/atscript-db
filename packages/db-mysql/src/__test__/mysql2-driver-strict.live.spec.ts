import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated (see insert-ignore.live.spec.ts): the driver makes a connection
// strict even when its session starts non-strict (simulated per connection —
// the shared server's GLOBAL sql_mode is never touched), and a missing NOT NULL
// column then raises in plain and ignore mode (since 0.1.148).

const SERVER_URL = process.env.ATSCRIPT_MYSQL_TEST_URL ?? "mysql://root:test@127.0.0.1:33071";
const DB = "driver_strict";

async function admin<T>(fn: (conn: any) => Promise<T>): Promise<T | undefined> {
  try {
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection({ uri: SERVER_URL, connectTimeout: 1500 });
    try {
      return await fn(conn);
    } finally {
      await conn.end();
    }
  } catch {
    return undefined;
  }
}

const reachable = (await admin((c) => c.query("SELECT 1"))) !== undefined;

const modeOf = async (driver: Mysql2Driver) =>
  ((await driver.get<{ m: string }>("SELECT @@SESSION.sql_mode AS m"))?.m ?? "").split(",");

/**
 * A pool whose every NEW connection starts non-strict — what a server with a
 * non-strict default (RDS) gives — without touching the shared server's GLOBAL
 * `sql_mode`: the listener runs before the driver's own, on the same session.
 */
async function nonStrictPool(db: string) {
  const mysql = await import("mysql2/promise");
  const pool = mysql.createPool({ uri: `${SERVER_URL}/${db}`, connectionLimit: 3 });
  (pool as any).on("connection", (conn: any) =>
    conn.query("SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'", () => {}),
  );
  return pool;
}

describe.skipIf(!reachable)("[mysql live] Mysql2Driver strictMode", () => {
  let fx: Record<string, any>;

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/insert-ignore.as");
    await admin((c) => c.query(`DROP DATABASE IF EXISTS \`${DB}\``));
    await admin((c) => c.query(`CREATE DATABASE \`${DB}\``));
    const driver = new Mysql2Driver(`${SERVER_URL}/${DB}`);
    const space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
    await new SchemaSync(space).run([fx.IgItem], { force: true });
    await space.close();
  });

  afterAll(async () => {
    await admin((c) => c.query(`DROP DATABASE IF EXISTS \`${DB}\``));
  });

  it("a fresh connection is strict and keeps the other modes", async () => {
    const pool = await nonStrictPool(DB);
    const driver = new Mysql2Driver(pool);
    try {
      const modes = await modeOf(driver);
      expect(modes).toContain("STRICT_TRANS_TABLES");
      expect(modes).toContain("NO_ENGINE_SUBSTITUTION");
    } finally {
      await driver.close();
    }
  });

  it("every connection of a pre-used pool is strict, not just the ones opened afterwards", async () => {
    const mysql = await import("mysql2/promise");
    const pool = mysql.createPool({ uri: `${SERVER_URL}/${DB}`, connectionLimit: 3 });
    // the app warmed the pool (health check) on a non-strict session BEFORE the driver existed
    const warm = await Promise.all([pool.getConnection(), pool.getConnection()]);
    for (const conn of warm) await conn.query("SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'");
    for (const conn of warm) conn.release();
    const driver = new Mysql2Driver(pool);
    try {
      const a = await driver.getConnection();
      const b = await driver.getConnection();
      const c = await driver.getConnection();
      try {
        for (const conn of [a, b, c]) {
          const row = await conn.get<{ m: string }>("SELECT @@SESSION.sql_mode AS m");
          expect(row?.m.split(",")).toContain("STRICT_TRANS_TABLES");
        }
      } finally {
        a.release();
        b.release();
        c.release();
      }
      // the pool-level path hits whichever connection is free
      for (let i = 0; i < 6; i++) expect(await modeOf(driver)).toContain("STRICT_TRANS_TABLES");
    } finally {
      await driver.close();
    }
  });

  it("strictMode: false keeps the non-strict mode of the session", async () => {
    const driver = new Mysql2Driver(await nonStrictPool(DB), { strictMode: false });
    try {
      expect(await modeOf(driver)).not.toContain("STRICT_TRANS_TABLES");
      // the coercion the opt-out accepts: a missing NOT NULL column is stored as ''
      await driver.run("INSERT INTO `ig_items` (`id`) VALUES (900)");
      expect((await driver.get<any>("SELECT `sku` FROM `ig_items` WHERE `id` = 900"))?.sku).toBe(
        "",
      );
    } finally {
      await driver.close();
    }
  });

  it("a missing NOT NULL column raises in plain and ignore mode", async () => {
    const driver = new Mysql2Driver(await nonStrictPool(DB));
    const space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
    try {
      const table = space.getTable(fx.IgItem as never) as any;
      await expect(table.insertMany([{ id: 901 }])).rejects.toThrow();
      await expect(table.insertMany([{ id: 902 }], { onConflict: "ignore" })).rejects.toThrow();
      const rows = await table.findMany({ filter: { id: { $in: [901, 902] } } });
      expect(rows).toEqual([]);
    } finally {
      await space.close();
    }
  });
});
