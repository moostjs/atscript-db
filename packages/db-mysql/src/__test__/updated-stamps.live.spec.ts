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
// `number.timestamp.updated` (atscript 0.1.106) is a `TIMESTAMP DEFAULT CURRENT_TIMESTAMP` column
// set by every update — on a fresh table and on one created by an earlier version.

const DB = "updated_stamps";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let driver: Mysql2Driver;
let space: DbSpace;

async function column(name: string, table: string) {
  return driver.get<{ data_type: string; column_default: string | null }>(
    `SELECT DATA_TYPE AS data_type, COLUMN_DEFAULT AS column_default FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, name],
  );
}

const OLD = 1_700_000_000_000;
/** Whole seconds — a MySQL `TIMESTAMP` keeps no fraction. */
const sec = () => Math.floor(Date.now() / 1000) * 1000;
const doc = (id: number) => ({ id, title: "t", audit: {} });
const old = (id: number) => ({
  id,
  title: "t",
  updatedAt: OLD,
  aliased: OLD,
  nullable: OLD as number | null,
  audit: { at: OLD },
});

const stamps = (row: any) => [row.updatedAt, row.aliased, row.nullable, row.audit.at];

/** Every write path of a table of `UpdDoc`. */
async function checkUpdatedStamps(table: any): Promise<void> {
  let before = sec();
  await table.insertOne(doc(1));
  for (const v of stamps(await table.findById(1))) expect(v).toBeGreaterThanOrEqual(before);

  // an explicit value wins on insert
  await table.insertMany([old(2), old(3), old(4), { ...old(5), nullable: null }, old(6), old(7)]);
  expect(await table.findById(2)).toMatchObject(old(2));
  expect(((await table.findById(5)) as any).nullable).toBeNull();

  // a patch sets the row's own fields, overriding a supplied value; a nested
  // one only when the patch carries its object
  before = sec();
  await table.updateOne({ id: 2, title: "p", updatedAt: OLD });
  let row = (await table.findById(2)) as any;
  for (const v of [row.updatedAt, row.aliased, row.nullable]) {
    expect(v).toBeGreaterThanOrEqual(before);
  }
  expect(row.audit.at).toBe(OLD);
  await table.updateOne({ id: 2, audit: { note: "n" } });
  row = (await table.findById(2)) as any;
  expect(row.audit).toEqual({ note: "n", at: expect.any(Number) });
  expect(row.audit.at).toBeGreaterThanOrEqual(before);

  // a patch with nothing else to write is a no-op
  await table.updateOne({ id: 3, updatedAt: 5 });
  expect(await table.findById(3)).toMatchObject(old(3));

  // updateMany and bulkUpdate
  await table.updateMany({ id: 3 }, { title: "m" });
  await table.bulkUpdate([
    { id: 4, title: "b" },
    { id: 5, title: "b" },
  ]);
  for (const id of [3, 4, 5]) {
    row = (await table.findById(id)) as any;
    expect(row.updatedAt, `${id}`).toBeGreaterThanOrEqual(before);
    expect(row.nullable, `${id}`).toBeGreaterThanOrEqual(before);
    expect(row.audit.at, `${id}`).toBe(OLD);
  }

  // replaceOne, bulkReplace and replaceMany set every field, overriding supplied values
  await table.replaceOne(old(1));
  await table.bulkReplace([old(6)]);
  await table.replaceMany({ id: 7 }, old(7));
  for (const id of [1, 6, 7]) {
    for (const v of stamps(await table.findById(id))) {
      expect(v, `${id}`).toBeGreaterThanOrEqual(before);
    }
  }
}

/** A table synced as `UpdBefore` (the <= 0.1.155 layout), populated, then synced as `UpdAfter`. */
async function checkUpgrade(space: any, SchemaSync: any): Promise<void> {
  expect((await new SchemaSync(space).run([fx.UpdBefore], { force: true })).status).toBe("synced");
  await space.getTable(fx.UpdBefore).insertOne({ id: 1, title: "a", updatedAt: OLD, maybe: OLD });
  await space.getTable(fx.UpdBefore).insertOne({ id: 2, title: "a", updatedAt: OLD, maybe: null });
  const result = await new SchemaSync(space).run([fx.UpdAfter], { force: true });
  expect(result.status).toBe("synced");
  expect(result.entries[0]!.errors ?? []).toEqual([]);
  const table = space.getTable(fx.UpdAfter);
  expect(await table.findById(1)).toMatchObject({ updatedAt: OLD, maybe: OLD });
  expect(await table.findById(2)).toMatchObject({ updatedAt: OLD, maybe: null });
  const before = sec();
  await table.updateOne({ id: 1, title: "b" });
  const row = (await table.findById(1)) as any;
  expect(row.updatedAt).toBeGreaterThanOrEqual(before);
  expect(row.maybe).toBeGreaterThanOrEqual(before);
  await table.insertOne({ id: 3 });
  expect(((await table.findById(3)) as any).updatedAt).toBeGreaterThanOrEqual(before);
  expect((await new SchemaSync(space).run([fx.UpdAfter])).status).toBe("up-to-date");
}

describe.skipIf(!reachable)("[mysql live] number.timestamp.updated", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/updated-stamps.as");
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
  });

  afterAll(async () => {
    await space?.close();
    await dropMysqlDatabase(DB);
  });

  it("a fresh table: timestamp with the now default, set on insert and by every patch and replace", async () => {
    expect((await new SchemaSync(space).run([fx.UpdDoc], { force: true })).status).toBe("synced");
    for (const name of ["updatedAt", "aliased", "nullable", "audit__at"]) {
      const col = await column(name, "upd_docs");
      expect(col?.data_type, name).toBe("timestamp");
      expect(col?.column_default, name).toMatch(/current_timestamp/i);
    }
    await checkUpdatedStamps(space.getTable(fx.UpdDoc));
  });

  it("a populated table from an earlier version is converted, then set by updates", async () => {
    await checkUpgrade(space, SchemaSync);
    for (const name of ["updatedAt", "maybe"]) {
      const col = await column(name, "upd_upgrade");
      expect(col?.data_type, name).toBe("timestamp");
      expect(col?.column_default, name).toMatch(/current_timestamp/i);
    }
  });

  it("a stored 0 fails the table's sync (column kept, writes refused) until the rows are fixed", async () => {
    await driver.exec("DROP TABLE IF EXISTS `upd_upgrade`");
    expect((await new SchemaSync(space).run([fx.UpdBefore], { force: true })).status).toBe(
      "synced",
    );
    await space.getTable(fx.UpdBefore).insertOne({ id: 1, title: "a", updatedAt: 0, maybe: null });
    const failed = await new SchemaSync(space).run([fx.UpdAfter], { force: true });
    expect(failed.entries[0]!.status).toBe("error");
    expect((await column("updatedAt", "upd_upgrade"))?.data_type).toBe("double");
    expect(await column("updatedAt__ts_mig", "upd_upgrade")).toBeNull();
    const table = space.getTable(fx.UpdAfter);
    await expect(table.updateOne({ id: 1, title: "b" })).rejects.toThrow();
    expect(await table.findById(1)).toMatchObject({ title: "a", updatedAt: 0 });

    await driver.run("UPDATE `upd_upgrade` SET `updatedAt` = ? WHERE `updatedAt` < 1000", [OLD]);
    const fixed = await new SchemaSync(space).run([fx.UpdAfter], { force: true });
    expect(fixed.entries[0]).toMatchObject({ status: "alter", errors: [] });
    expect(await table.findById(1)).toMatchObject({ title: "a", updatedAt: OLD });
  });
});
