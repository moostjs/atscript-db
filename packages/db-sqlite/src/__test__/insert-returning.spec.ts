import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.165 `insertOne(row, { returning })` reads the stored row back by
// its primary key in the insert's transaction: `true` → every field (server
// defaults and stamps included), a field list → those fields.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let notes: any;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/created-insert-only.as");
});

beforeEach(async () => {
  driver = new BetterSqlite3Driver(":memory:");
  const space = new DbSpace(() => new SqliteAdapter(driver));
  notes = space.getTable(fx.CioNote);
  await notes.ensureTable();
});

afterEach(() => {
  driver.close();
});

describe("[sqlite] insertOne({ returning })", () => {
  it("returning: true answers the stored row, server-set fields included", async () => {
    const result = await notes.insertOne({ id: 1, title: "a" }, { returning: true });
    expect(result.insertedId).toBe(1);
    expect(result.row).toMatchObject({ id: 1, title: "a" });
    expect(typeof result.row.createdAt).toBe("number");
    expect(result.row.createdAt).toBe(result.row.updatedAt);
  });

  it("a field list answers those fields", async () => {
    const result = await notes.insertOne({ id: 2, title: "b" }, { returning: ["id", "createdAt"] });
    expect(Object.keys(result.row).toSorted()).toEqual(["createdAt", "id"]);
  });

  it("with onConflict: 'ignore' a skipped row answers no row", async () => {
    await notes.insertOne({ id: 3, title: "c" });
    const result = await notes.insertOne(
      { id: 3, title: "again" },
      { onConflict: "ignore", returning: true },
    );
    expect(result).toEqual({ conflict: true });
  });
});
