import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise. Override with `ATSCRIPT_PG_TEST_URL` (or `POSTGRES_TEST_URI`; an
// admin connection — the spec creates and drops its own database).
// `number.timestamp.created` is a `DEFAULT now` column (atscript 0.1.104) and an
// embedded object's `@meta.id` stays out of the primary key — on a fresh table
// and when syncing a table created by an earlier version.

const DB = "primitive_defaults_pk";

const reachable = await pgReachable();

let fx: Record<string, any>;
let driver: PgDriver;
let space: DbSpace;

const order = (id: number, lineId: string) => ({ id, line: { lineId, qty: 1 }, audit: {} });

async function primaryKey(): Promise<string[]> {
  const rows = await driver.all<{ attname: string }>(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'emb_orders'::regclass AND i.indisprimary ORDER BY a.attname`,
  );
  return rows.map((r) => r.attname);
}

async function column(name: string, table = "emb_orders") {
  return driver.get<{ data_type: string; column_default: string | null }>(
    `SELECT data_type, column_default FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, name],
  );
}

describe.skipIf(!reachable)("[postgres live] number.timestamp.created + embedded @meta.id", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/embedded-id.as");
    driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
    space = new DbSpace(() => new PostgresAdapter(driver), { onClose: () => driver.close() });
  });

  afterAll(async () => {
    await space?.close();
    await dropPgDatabase(DB);
  });

  it("a fresh table: host-only primary key, DEFAULT now, filled on insert", async () => {
    const result = await new SchemaSync(space).run([fx.EmbOrder], { force: true });
    expect(result.status).toBe("synced");
    expect(await primaryKey()).toEqual(["id"]);
    for (const name of ["createdAt", "audit__at"]) {
      const col = await column(name);
      expect(col?.data_type, name).toBe("bigint");
      expect(col?.column_default, name).toMatch(/now\(\)/);
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
    await driver.exec(`DROP TABLE IF EXISTS "emb_orders"`);
    await driver.exec(
      `CREATE TABLE "emb_orders" ("id" DOUBLE PRECISION NOT NULL, "line__lineId" VARCHAR(255) NOT NULL, ` +
        `"line__qty" DOUBLE PRECISION NOT NULL, "createdAt" DOUBLE PRECISION NOT NULL, ` +
        `"audit__at" DOUBLE PRECISION NOT NULL, PRIMARY KEY ("id", "line__lineId"))`,
    );
    await driver.exec(`INSERT INTO "emb_orders" VALUES ${rows}`);
  }

  it("a populated table from an earlier version: the key is rebuilt in place", async () => {
    await legacyTable(
      `(1, 'a', 1, 1700000000123, 1700000000456), (2, 'b', 1, 1700000000789, 1700000000999)`,
    );
    const result = await new SchemaSync(space).run([fx.EmbOrder], { force: true });
    expect(result.status).toBe("synced");
    expect(result.entries[0]!.pkChange).toMatchObject({ from: ["id", "line__lineId"], to: ["id"] });
    expect(await primaryKey()).toEqual(["id"]);
    expect((await column("createdAt"))?.data_type).toBe("bigint");
    expect((await column("line__lineId"))?.data_type).toBe("text");
    const table = space.getTable(fx.EmbOrder);
    expect(await table.findById(1)).toMatchObject({
      line: { lineId: "a" },
      createdAt: 1700000000123,
      audit: { at: 1700000000456 },
    });
    expect(await table.count()).toBe(2);
    await expect(table.insertOne(order(1, "c") as any)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rows sharing a host id refuse the rebuild, naming the key and the count", async () => {
    await legacyTable(`(1, 'a', 1, 1, 1), (1, 'b', 1, 2, 2), (1, 'c', 1, 3, 3), (2, 'a', 1, 4, 4)`);
    const refused = await new SchemaSync(space).run([fx.EmbOrder], { force: true });
    expect(refused.status).toBe("refused");
    expect(refused.entries[0]!.errors).toEqual([
      'Primary key of "emb_orders" changed (id, line__lineId → id) but 3 rows have a NULL or duplicate (id) — fix or remove them (or migrate manually) and re-run.',
    ]);
    expect(await primaryKey()).toEqual(["id", "line__lineId"]);
    await driver.exec(`DELETE FROM "emb_orders" WHERE "id" = 1 AND "line__lineId" <> 'a'`);
    expect((await new SchemaSync(space).run([fx.EmbOrder], { force: true })).status).toBe("synced");
    expect(await primaryKey()).toEqual(["id"]);
  });

  it("number.timestamp → number.timestamp.created on a synced, populated table", async () => {
    const before = await new SchemaSync(space).run([fx.TsBefore], { force: true });
    expect(before.status).toBe("synced");
    await space.getTable(fx.TsBefore).insertOne({
      id: 1,
      createdAt: 1700000000123,
      audit: { at: 1700000000456 },
    } as any);
    // a fractional epoch (written by other code — a DOUBLE PRECISION column
    // holds any number) is rounded
    await driver.exec(
      `INSERT INTO "ts_upgrade" ("id", "createdAt", "audit__at") VALUES (3, 1700000000123.6, 1700000000456.4)`,
    );
    const result = await new SchemaSync(space).run([fx.TsAfter], { force: true });
    expect(result.status).toBe("synced");
    for (const name of ["createdAt", "audit__at"]) {
      const col = await column(name, "ts_upgrade");
      expect(col?.data_type, name).toBe("bigint");
      expect(col?.column_default, name).toMatch(/now\(\)/);
    }
    const table = space.getTable(fx.TsAfter);
    expect(await table.findById(1)).toMatchObject({
      createdAt: 1700000000123,
      audit: { at: 1700000000456 },
    });
    expect(await table.findById(3)).toMatchObject({
      createdAt: 1700000000124,
      audit: { at: 1700000000456 },
    });
    await table.insertOne({ id: 2, audit: {} } as any);
    const row = (await table.findById(2)) as any;
    expect(row.createdAt).toBeGreaterThan(1700000000456);
    expect(row.audit.at).toBeGreaterThan(1700000000456);
    expect((await new SchemaSync(space).run([fx.TsAfter])).status).toBe("up-to-date");
  });

  it("a `T | null` timestamp stored as union text by an earlier version is converted", async () => {
    await driver.exec('DROP TABLE IF EXISTS "ts_nullable"');
    await driver.exec(
      'CREATE TABLE "ts_nullable" ("id" DOUBLE PRECISION PRIMARY KEY, "closedAt" TEXT NOT NULL)',
    );
    await driver.exec(
      `INSERT INTO "ts_nullable" VALUES (1, '1700000000123'), (2, '1700000000789')`,
    );
    const result = await new SchemaSync(space).run([fx.TsNullable], { force: true });
    expect(result.entries[0]).toMatchObject({ status: "alter", errors: [] });
    const col = await column("closedAt", "ts_nullable");
    expect(col?.data_type).toBe("bigint");
    expect(col?.column_default).toMatch(/now\(\)/);
    const table = space.getTable(fx.TsNullable);
    expect(await table.findById(1)).toEqual({ id: 1, closedAt: 1700000000123 });
    await table.insertOne({ id: 3, closedAt: null } as any);
    expect(await table.findById(3)).toEqual({ id: 3, closedAt: null });
    await table.insertOne({ id: 4 } as any);
    expect(((await table.findById(4)) as any).closedAt).toBeGreaterThan(1700000000000);
  });

  it("an absent optional object stays absent although its columns have a now default", async () => {
    expect((await new SchemaSync(space).run([fx.TsAbsent], { force: true })).status).toBe("synced");
    const table = space.getTable(fx.TsAbsent);
    await table.insertOne({ id: 1 } as any);
    await table.insertOne({ id: 2, audit: null } as any);
    await table.insertOne({ id: 3, audit: {} } as any);
    await table.insertOne({ id: 4, pay: { kind: "bank", iban: "DE" } } as any);
    const rows = (await table.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];
    expect(rows[0]!.audit ?? null).toBeNull();
    expect(rows[1]!.audit ?? null).toBeNull();
    expect(rows[2]!.audit.at).toBeGreaterThan(1700000000000);
    expect(rows[3]!.pay).toEqual({ kind: "bank", iban: "DE" });
    // a replace without the object clears it
    await table.replaceOne({ id: 3 } as any);
    expect(((await table.findById(3)) as any).audit ?? null).toBeNull();
  });
});
