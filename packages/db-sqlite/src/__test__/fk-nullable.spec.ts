import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbError, DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.165 a foreign key typed `Target.id | null` is a real foreign key
// (constraint, relation pairing) that accepts null — like `field?: Target.id`.
// Before, the compiler refused it and the runtime registered no foreign key.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/fk-nullable.as");
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  for (const type of [fx.FknPerson, fx.FknItem]) await space.getTable(type).ensureTable();
  await space.getTable(fx.FknPerson).insertOne({ id: 1, name: "p" });
});

afterAll(() => {
  driver.close();
});

describe("[sqlite] @db.rel.FK on `ref | null`", () => {
  it("registers the foreign key", () => {
    const items: any = space.getTable(fx.FknItem);
    expect([...items.foreignKeys.values()].map((fk: any) => [fk.fields, fk.targetTable])).toEqual([
      [["ownerId"], "fkn_people"],
    ]);
  });

  it("accepts null and an existing target; refuses a missing one", async () => {
    const items: any = space.getTable(fx.FknItem);
    await items.insertOne({ id: 1, ownerId: null });
    await items.insertOne({ id: 2, ownerId: 1 });
    const error = await items.insertOne({ id: 3, ownerId: 9 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("FK_VIOLATION");
  });

  it("pairs with @db.rel.to", async () => {
    const items: any = space.getTable(fx.FknItem);
    const rows = await items.findMany({ filter: {}, controls: { $with: [{ name: "owner" }] } });
    expect(rows.map((r: any) => [r.id, r.owner?.name ?? null])).toEqual([
      [1, null],
      [2, "p"],
    ]);
  });
});
