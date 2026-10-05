import { describe, it, expect, beforeAll, beforeEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise (CI has no server). Override with `ATSCRIPT_PG_TEST_URL` (an admin
// connection; the spec creates and drops its own `insert_ignore` database).
// Conflict-ignoring insert (since 0.1.148) + DbSpace.close() end to end.

const SERVER_URL =
  process.env.ATSCRIPT_PG_TEST_URL ?? "postgresql://postgres:test@127.0.0.1:54371/postgres";
const DB = "insert_ignore";

async function adminQuery(sql: string): Promise<boolean> {
  try {
    const { Client } = (await import("pg")).default;
    const client = new Client({ connectionString: SERVER_URL, connectionTimeoutMillis: 1500 });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
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

describe.skipIf(!reachable)("[postgres live] insert onConflict: ignore", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/insert-ignore.as");
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}"`);
    await adminQuery(`CREATE DATABASE "${DB}"`);
    const url = new URL(SERVER_URL);
    url.pathname = `/${DB}`;
    const driver = new PgDriver({ connectionString: url.toString() });
    space = new DbSpace(
      () => {
        const adapter = new PostgresAdapter(driver);
        adapter.setVerbose(true);
        return adapter;
      },
      { logger, onClose: () => driver.close() },
    );
    const result = await new SchemaSync(space).run([fx.IgItem, fx.IgAuto, fx.IgNote, fx.IgPrice], {
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
    await t(fx.IgPrice).deleteMany({});
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

  it("an unmappable RETURNING (a key the server rounds) rolls the chunk back and redoes it per row", async () => {
    const prices = t(fx.IgPrice);
    await prices.insertOne({ price: 2.5 });
    statements.length = 0;
    // NUMERIC(10,2) rounds the sent 1.555 / 3.555 to 1.56 / 3.56: RETURNING cannot
    // be matched to the input by key, so the chunk is redone row by row.
    const result = await prices.insertMany([{ price: 1.555 }, { price: 2.5 }, { price: 3.555 }], {
      onConflict: "ignore",
    });
    expect(result.inserted).toEqual([0, 2]);
    expect(result.conflicts).toEqual([1]);
    const stored = (await prices.findMany({
      filter: {},
      controls: { $sort: { price: 1 } },
    })) as any[];
    expect(stored.map((r) => Number(r.price))).toEqual([1.56, 2.5, 3.56]);
    expect(result.insertedIds).toEqual([stored[0].id, stored[2].id]);
    // 1 batched statement + 3 single-row retries
    expect(statements.filter((s) => s.startsWith("INSERT"))).toHaveLength(4);
  });

  it("a mappable batch stays ONE statement", async () => {
    await items().insertMany([item(1, "a")]);
    statements.length = 0;
    await items().insertMany([item(2, "a"), item(3, "c"), item(4, "d")], { onConflict: "ignore" });
    expect(statements.filter((s) => s.startsWith("INSERT"))).toHaveLength(1);
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
