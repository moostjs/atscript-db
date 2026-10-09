import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since atscript 0.1.103 `number.timestamp.created | null` carries
// `@db.default.now` on its member. Members are not columns: the table is the
// same as with atscript 0.1.102 and no member default is filled on insert.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/union-members.as");
});

describe("SqliteAdapter — union / tuple members", () => {
  it("CREATE TABLE ignores member annotations", async () => {
    const driver = new BetterSqlite3Driver(":memory:");
    const table = new DbSpace(() => new SqliteAdapter(driver)).getTable(fx.UnionMembers);
    await table.ensureTable();
    const { sql } = driver.get("SELECT sql FROM sqlite_master WHERE name = 'union_members'") as {
      sql: string;
    };
    expect(sql).toBe(
      'CREATE TABLE "union_members" ("id" INTEGER PRIMARY KEY, "x" TEXT NOT NULL, "y" TEXT, "pair" TEXT NOT NULL, "emails" TEXT NOT NULL, "n" TEXT NOT NULL, "code" TEXT NOT NULL, "created" REAL NOT NULL)',
    );

    const row = { pair: [1, "a"], emails: ["a@b.co"], n: 2, code: "abc", created: 1 };
    await table.insertOne({ id: 1, x: 5, ...row } as any);
    expect(await table.findOne({ filter: { id: 1 }, controls: {} } as any)).toMatchObject({
      y: null,
    });
    await expect(table.insertOne({ id: 2, ...row } as any)).rejects.toThrow(/x/);
    driver.close();
  });
});
