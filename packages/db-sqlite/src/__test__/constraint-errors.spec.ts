import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { caught, prepareFixtures } from "./test-utils";

// Since 0.1.165 an engine constraint error is normalized by the table layer:
// one entry per logical field of the violated constraint, a per-entry `code`
// (`UNIQUE` / `FK_MISSING` / `FK_RESTRICT`) with `params`, a plain message,
// and the engine's text in `details`. Before, a compound unique key reported
// the mangled path `householdId,`, an FK failure listed every FK field, and
// every message was the raw SQLite text.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

const t = (type: unknown): any => space.getTable(type as never);

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/constraint-errors.as");
});

beforeEach(async () => {
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  for (const type of [fx.CeHousehold, fx.CePerson, fx.CeItem]) {
    await t(type).ensureTable();
    await t(type).syncIndexes();
  }
  await t(fx.CeHousehold).insertOne({ id: 1, name: "h" });
  await t(fx.CePerson).insertOne({ id: 1, name: "p" });
  await t(fx.CeItem).insertOne({ id: 1, householdId: 1, name: "salt", code: "A" });
});

afterEach(() => {
  driver.close();
});

describe("[sqlite] constraint errors", () => {
  it("a compound unique key: one UNIQUE entry per field, raw text in details", async () => {
    const error = await caught(
      t(fx.CeItem).insertOne({ id: 2, householdId: 1, name: "salt", code: "B" }),
    );
    expect(error.code).toBe("CONFLICT");
    const params = { index: "ce_household_name", fields: ["householdId", "name"] };
    expect(error.errors).toEqual([
      {
        path: "householdId",
        message: 'The combination of "householdId", "name" must be unique',
        code: "UNIQUE",
        params,
        details: expect.stringContaining("UNIQUE constraint failed"),
      },
      expect.objectContaining({ path: "name", code: "UNIQUE", params }),
    ]);
    expect(error.message).not.toContain("UNIQUE constraint failed");
  });

  it("a single-field unique key names its field and index", async () => {
    const error = await caught(
      t(fx.CeItem).insertOne({ id: 2, householdId: 1, name: "pepper", code: "A" }),
    );
    expect(error.errors).toEqual([
      expect.objectContaining({
        path: "code",
        message: "Value must be unique",
        code: "UNIQUE",
        params: { index: "ce_code", fields: ["code"] },
      }),
    ]);
  });

  it("a primary-key collision is a UNIQUE entry on the key", async () => {
    const error = await caught(
      t(fx.CeItem).insertOne({ id: 1, householdId: 1, name: "x", code: "Z" }),
    );
    expect(error.errors).toEqual([
      expect.objectContaining({
        path: "id",
        code: "UNIQUE",
        params: { index: "primaryKey", fields: ["id"] },
      }),
    ]);
  });

  it("an FK failure names only the failing key", async () => {
    const error = await caught(
      t(fx.CeItem).insertOne({ id: 2, householdId: 1, name: "x", code: "Z", ownerId: 99 }),
    );
    expect(error.code).toBe("FK_VIOLATION");
    expect(error.errors).toEqual([
      {
        path: "ownerId",
        message: 'References a non-existent record in "ce_people"',
        code: "FK_MISSING",
        params: { fields: ["ownerId"], target: "ce_people" },
        details: expect.stringContaining("FOREIGN KEY constraint failed"),
      },
    ]);
  });

  it("an FK failure on update names the failing key too", async () => {
    const error = await caught(t(fx.CeItem).updateOne({ id: 1, householdId: 42 }));
    expect(error.errors.map((e) => [e.path, e.code])).toEqual([["householdId", "FK_MISSING"]]);
  });

  it("a blocked delete is an FK_RESTRICT entry", async () => {
    const error = await caught(t(fx.CeHousehold).deleteOne(1));
    expect(error.code).toBe("CONFLICT");
    expect(error.errors).toEqual([
      expect.objectContaining({
        path: "ce_households",
        code: "FK_RESTRICT",
        params: { table: "ce_households" },
      }),
    ]);
  });
});
