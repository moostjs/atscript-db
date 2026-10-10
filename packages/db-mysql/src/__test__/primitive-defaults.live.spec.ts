import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips
// otherwise. Override with `ATSCRIPT_MYSQL_TEST_URL` (or `MYSQL_TEST_URI`; an
// admin connection — the spec creates and drops its own database).
// `number.timestamp.created` is a `DEFAULT CURRENT_TIMESTAMP` column (atscript
// 0.1.104) and an embedded object's `@meta.id` stays out of the primary key —
// on a fresh table and when syncing a table created by an earlier version.

const DB = "primitive_defaults_pk";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let driver: Mysql2Driver;
let space: DbSpace;

const order = (id: number, lineId: string) => ({ id, line: { lineId, qty: 1 }, audit: {} });

async function primaryKey(table = "emb_orders"): Promise<string[]> {
  const rows = await driver.all<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY COLUMN_NAME`,
    [table],
  );
  return rows.map((r) => r.COLUMN_NAME);
}

async function column(name: string, table = "emb_orders") {
  return driver.get<{ DATA_TYPE: string; COLUMN_DEFAULT: string | null }>(
    `SELECT DATA_TYPE, COLUMN_DEFAULT FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, name],
  );
}

describe.skipIf(!reachable)("[mysql live] number.timestamp.created + embedded @meta.id", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/embedded-id.as");
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
  });

  afterAll(async () => {
    await space?.close();
    await dropMysqlDatabase(DB);
  });

  it("a fresh table: host-only primary key, DEFAULT CURRENT_TIMESTAMP, filled on insert", async () => {
    const result = await new SchemaSync(space).run([fx.EmbOrder], { force: true });
    expect(result.status).toBe("synced");
    expect(await primaryKey()).toEqual(["id"]);
    for (const name of ["createdAt", "audit__at"]) {
      const col = await column(name);
      expect(col?.DATA_TYPE, name).toBe("timestamp");
      expect(col?.COLUMN_DEFAULT, name).toMatch(/current_timestamp/i);
    }
    const table = space.getTable(fx.EmbOrder);
    const before = Date.now() - 5000;
    await table.insertOne(order(1, "a") as any);
    const row = (await table.findById(1)) as any;
    expect(row.createdAt).toBeGreaterThan(before);
    expect(row.audit.at).toBeGreaterThan(before);
    await expect(table.insertOne(order(1, "b") as any)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  /** The table atscript-db <= 0.1.154 created for `EmbOrder` (embedded id in the key), with rows. */
  async function legacyTable(rows: string): Promise<void> {
    await driver.exec("DROP TABLE IF EXISTS `emb_orders`");
    await driver.exec(
      "CREATE TABLE `emb_orders` (`id` DOUBLE NOT NULL, `line__lineId` VARCHAR(255) NOT NULL, " +
        "`line__qty` DOUBLE NOT NULL, `createdAt` DOUBLE NOT NULL, `audit__at` DOUBLE NOT NULL, " +
        "PRIMARY KEY (`id`, `line__lineId`))",
    );
    await driver.exec(`INSERT INTO \`emb_orders\` VALUES ${rows}`);
  }

  it("a populated table from an earlier version: the key is rebuilt in place", async () => {
    await legacyTable(
      "(1, 'a', 1, 1700000000123, 1700000000456), (2, 'b', 1, 1700000000789, 1700000000999)",
    );
    const result = await new SchemaSync(space).run([fx.EmbOrder], { force: true });
    expect(result.status).toBe("synced");
    expect(result.entries[0]!.pkChange).toMatchObject({ from: ["id", "line__lineId"], to: ["id"] });
    expect(await primaryKey()).toEqual(["id"]);
    // the demoted key column becomes TEXT in the key swap
    expect((await column("line__lineId"))?.DATA_TYPE).toBe("text");
    const table = space.getTable(fx.EmbOrder);
    expect(await table.findById(1)).toMatchObject({
      line: { lineId: "a" },
      createdAt: 1700000000000,
      audit: { at: 1700000000000 },
    });
    // truncated to whole seconds, like a written value
    expect(await table.findById(2)).toMatchObject({ createdAt: 1700000000000 });
    expect(await table.count()).toBe(2);
    await expect(table.insertOne(order(1, "c") as any)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rows sharing a host id refuse the rebuild, naming the key and the count", async () => {
    await legacyTable("(1, 'a', 1, 1, 1), (1, 'b', 1, 2, 2), (1, 'c', 1, 3, 3), (2, 'a', 1, 4, 4)");
    const refused = await new SchemaSync(space).run([fx.EmbOrder], { force: true });
    expect(refused.status).toBe("refused");
    expect(refused.entries[0]!.errors).toEqual([
      'Primary key of "emb_orders" changed (id, line__lineId → id) but 3 rows have a NULL or duplicate (id) — fix or remove them (or migrate manually) and re-run.',
    ]);
    expect(await primaryKey()).toEqual(["id", "line__lineId"]);
  });

  it("number.timestamp → number.timestamp.created on a synced, populated table", async () => {
    const before = await new SchemaSync(space).run([fx.TsBefore], { force: true });
    expect(before.status).toBe("synced");
    await space.getTable(fx.TsBefore).insertOne({
      id: 1,
      createdAt: 1700000000123,
      audit: { at: 1700000000456 },
    } as any);
    const columnOrder = async () =>
      (
        await driver.all<{ COLUMN_NAME: string }>(
          `SELECT COLUMN_NAME FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ts_upgrade' ORDER BY ORDINAL_POSITION`,
        )
      ).map((c) => c.COLUMN_NAME);
    const columnsBefore = await columnOrder();
    const result = await new SchemaSync(space).run([fx.TsAfter], { force: true });
    expect(result.status).toBe("synced");
    for (const name of ["createdAt", "audit__at"]) {
      const col = await column(name, "ts_upgrade");
      expect(col?.DATA_TYPE, name).toBe("timestamp");
      expect(col?.COLUMN_DEFAULT, name).toMatch(/current_timestamp/i);
    }
    // converted in place: the columns keep their position
    expect(await columnOrder()).toEqual(columnsBefore);
    const table = space.getTable(fx.TsAfter);
    // TIMESTAMP keeps whole seconds
    expect(await table.findById(1)).toMatchObject({
      createdAt: 1700000000000,
      audit: { at: 1700000000000 },
    });
    await table.insertOne({ id: 2, audit: {} } as any);
    const row = (await table.findById(2)) as any;
    expect(row.createdAt).toBeGreaterThan(1700000000000);
    expect(row.audit.at).toBeGreaterThan(1700000000000);
    expect((await new SchemaSync(space).run([fx.TsAfter])).status).toBe("up-to-date");
  });

  it("@db.mysql.type TIMESTAMP(3) keeps the milliseconds through the conversion", async () => {
    expect((await new SchemaSync(space).run([fx.TsMsBefore], { force: true })).status).toBe(
      "synced",
    );
    await space.getTable(fx.TsMsBefore).insertOne({ id: 1, createdAt: 1700000000123 } as any);
    const result = await new SchemaSync(space).run([fx.TsMsAfter], { force: true });
    expect(result.status).toBe("synced");
    const col = await driver.get<{ COLUMN_TYPE: string; COLUMN_DEFAULT: string }>(
      `SELECT COLUMN_TYPE, COLUMN_DEFAULT FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ts_upgrade_ms' AND COLUMN_NAME = 'createdAt'`,
    );
    expect(col?.COLUMN_TYPE).toBe("timestamp(3)");
    expect(col?.COLUMN_DEFAULT).toMatch(/current_timestamp\(3\)/i);
    const table = space.getTable(fx.TsMsAfter);
    expect(await table.findById(1)).toMatchObject({ createdAt: 1700000000123 });
    // the same precision a written value keeps
    await table.insertOne({ id: 2, createdAt: 1700000000456 } as any);
    expect(await table.findById(2)).toMatchObject({ createdAt: 1700000000456 });
  });

  it("an explicit @db.default.now field stores the same whole seconds", async () => {
    await driver.exec("DROP TABLE IF EXISTS `ts_upgrade`");
    expect((await new SchemaSync(space).run([fx.TsAfter, fx.TsExplicit])).status).toBe("synced");
    for (const name of ["ts_upgrade", "ts_explicit"]) {
      const col = await column("createdAt", name);
      expect(col?.DATA_TYPE, name).toBe("timestamp");
    }
    const explicit = space.getTable(fx.TsExplicit);
    await explicit.insertOne({ id: 1, createdAt: 1700000000999 } as any);
    expect(await explicit.findById(1)).toMatchObject({ createdAt: 1700000000000 });
    const created = space.getTable(fx.TsAfter);
    await created.insertOne({ id: 1, createdAt: 1700000000999, audit: {} } as any);
    expect(await created.findById(1)).toMatchObject({ createdAt: 1700000000000 });
  });

  it("a stored value TIMESTAMP cannot hold fails the table's sync, the column kept", async () => {
    await driver.exec("DROP TABLE IF EXISTS `ts_upgrade`");
    expect((await new SchemaSync(space).run([fx.TsBefore], { force: true })).status).toBe("synced");
    await space.getTable(fx.TsBefore).insertOne({ id: 1, createdAt: 0, audit: { at: 0 } } as any);
    const result = await new SchemaSync(space).run([fx.TsAfter], { force: true });
    expect(result.entries[0]!.status).toBe("error");
    expect(result.entries[0]!.errors?.[0]).toMatch(/Column sync failed on ts_upgrade/);
    expect((await column("createdAt", "ts_upgrade"))?.DATA_TYPE).toBe("double");
    expect(await column("createdAt__ts_mig", "ts_upgrade")).toBeNull();
    expect(await space.getTable(fx.TsBefore).findById(1)).toMatchObject({ createdAt: 0 });
  });

  it("a `T | null` timestamp stored as union text by an earlier version is converted", async () => {
    await driver.exec("DROP TABLE IF EXISTS `ts_nullable`");
    await driver.exec(
      "CREATE TABLE `ts_nullable` (`id` DOUBLE PRIMARY KEY, `closedAt` TEXT NOT NULL) ENGINE=InnoDB",
    );
    await driver.exec(
      "INSERT INTO `ts_nullable` VALUES (1, '1700000000123'), (2, '2023-11-14 22:13:20')",
    );
    const result = await new SchemaSync(space).run([fx.TsNullable], { force: true });
    expect(result.entries[0]).toMatchObject({ status: "alter", errors: [] });
    const col = await column("closedAt", "ts_nullable");
    expect(col?.DATA_TYPE).toBe("timestamp");
    expect(col?.COLUMN_DEFAULT).toMatch(/current_timestamp/i);
    const table = space.getTable(fx.TsNullable);
    expect(await table.findById(1)).toEqual({ id: 1, closedAt: 1700000000000 });
    // text that is no number is read as a datetime, as a plain MODIFY would
    expect(await table.findById(2)).toEqual({ id: 2, closedAt: 1700000000000 });
    await table.insertOne({ id: 3, closedAt: null } as any);
    expect(await table.findById(3)).toEqual({ id: 3, closedAt: null });
    await table.insertOne({ id: 4 } as any);
    expect(((await table.findById(4)) as any).closedAt).toBeGreaterThan(1700000000000);
  });
});
