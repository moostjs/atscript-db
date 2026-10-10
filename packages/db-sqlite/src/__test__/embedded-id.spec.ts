import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/embedded-id.as");
});

const order = (id: number, lineId: string) => ({ id, line: { lineId, qty: 1 }, audit: {} });

describe("SqliteAdapter — embedded @meta.id and number.timestamp.created", () => {
  it("the primary key is the host's own @meta.id only", async () => {
    const driver = new BetterSqlite3Driver(":memory:");
    const table = new DbSpace(() => new SqliteAdapter(driver)).getTable(fx.EmbOrder);
    await table.ensureTable();
    const { sql } = driver.get("SELECT sql FROM sqlite_master WHERE name = 'emb_orders'") as {
      sql: string;
    };
    expect(sql).toContain('"id" INTEGER PRIMARY KEY');
    expect(sql).not.toContain("PRIMARY KEY (");
    await table.insertOne(order(1, "a") as any);
    await expect(table.insertOne(order(1, "b") as any)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    driver.close();
  });

  it("fills number.timestamp.created on insert, also inside an embedded object", async () => {
    const driver = new BetterSqlite3Driver(":memory:");
    const table = new DbSpace(() => new SqliteAdapter(driver)).getTable(fx.EmbOrder);
    await table.ensureTable();
    const before = Date.now();
    await table.insertOne(order(1, "a") as any);
    const row = (await table.findById(1)) as any;
    expect(row.createdAt).toBeGreaterThanOrEqual(before);
    expect(row.audit.at).toBeGreaterThanOrEqual(before);
    driver.close();
  });

  it("number.timestamp → number.timestamp.created syncs without DDL, then fills", async () => {
    const driver = new BetterSqlite3Driver(":memory:");
    const space = new DbSpace(() => new SqliteAdapter(driver));
    expect((await new SchemaSync(space).run([fx.TsBefore])).status).toBe("synced");
    await space.getTable(fx.TsBefore).insertOne({ id: 1, createdAt: 5 } as any);
    const result = await new SchemaSync(space).run([fx.TsAfter]);
    expect(result.status).toBe("synced");
    expect(result.entries[0]!.errors ?? []).toEqual([]);
    const table = space.getTable(fx.TsAfter);
    await table.insertOne({ id: 2 } as any);
    expect(await table.findById(1)).toMatchObject({ createdAt: 5 });
    expect(((await table.findById(2)) as any).createdAt).toBeGreaterThan(5);
    expect((await new SchemaSync(space).run([fx.TsAfter])).status).toBe("up-to-date");
    driver.close();
  });

  /** The table atscript-db <= 0.1.154 created for `EmbOrder` (embedded id in the key). */
  function legacySpace(rows: string) {
    const driver = new BetterSqlite3Driver(":memory:");
    driver.exec(
      'CREATE TABLE "emb_orders" ("id" INTEGER NOT NULL, "line__lineId" TEXT NOT NULL, ' +
        '"line__qty" REAL NOT NULL, "createdAt" REAL NOT NULL, "audit__at" REAL NOT NULL, ' +
        'PRIMARY KEY ("id", "line__lineId"))',
    );
    driver.exec(`INSERT INTO "emb_orders" VALUES ${rows}`);
    return { driver, space: new DbSpace(() => new SqliteAdapter(driver)) };
  }

  it("a populated table from an earlier version: recreated with the host key", async () => {
    const { driver, space } = legacySpace("(1, 'a', 1, 5, 6), (2, 'b', 1, 7, 8)");
    const result = await new SchemaSync(space).run([fx.EmbOrder]);
    expect(result.status).toBe("synced");
    expect(result.entries[0]!.pkChange).toMatchObject({ from: ["id", "line__lineId"], to: ["id"] });
    const { sql } = driver.get("SELECT sql FROM sqlite_master WHERE name = 'emb_orders'") as {
      sql: string;
    };
    expect(sql).toContain('"id" INTEGER PRIMARY KEY');
    const table = space.getTable(fx.EmbOrder);
    expect(await table.findById(1)).toMatchObject({
      line: { lineId: "a" },
      createdAt: 5,
      audit: { at: 6 },
    });
    expect(await table.count()).toBe(2);
    await expect(table.insertOne(order(1, "c") as any)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    driver.close();
  });

  it("rows sharing a host id refuse the rebuild, naming the key and the count", async () => {
    const { driver, space } = legacySpace(
      "(1, 'a', 1, 1, 1), (1, 'b', 1, 2, 2), (2, 'a', 1, 3, 3)",
    );
    const refused = await new SchemaSync(space).run([fx.EmbOrder]);
    expect(refused.status).toBe("refused");
    expect(refused.entries[0]!.errors).toEqual([
      'Primary key of "emb_orders" changed (id, line__lineId → id) but 2 rows have a NULL or duplicate (id) — fix or remove them (or migrate manually) and re-run.',
    ]);
    driver.close();
  });

  it("a synced composite key losing a member: populated table recreated with the data", async () => {
    const driver = new BetterSqlite3Driver(":memory:");
    const space = new DbSpace(() => new SqliteAdapter(driver));
    expect((await new SchemaSync(space).run([fx.KeyBefore])).status).toBe("synced");
    await space.getTable(fx.KeyBefore).insertMany([
      { id: 1, seq: 1, note: "a" },
      { id: 2, seq: 1, note: "b" },
    ] as any);
    const result = await new SchemaSync(space).run([fx.KeyAfter]);
    expect(result.status).toBe("synced");
    expect(result.entries[0]!.errors ?? []).toEqual([]);
    const table = space.getTable(fx.KeyAfter);
    expect(await table.findById(2)).toMatchObject({ seq: 1, note: "b" });
    expect((await new SchemaSync(space).run([fx.KeyAfter])).status).toBe("up-to-date");
    driver.close();
  });
});
