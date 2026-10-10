import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since atscript 0.1.103 `number.timestamp.created | null` carries
// `@db.default.now` on its member and `string.char | string` carries
// `@expect.maxLength 1`. Members are not columns — except the one non-null
// member of `T | null`, whose db annotations apply (a `now` default, filled on
// insert); `created: number.timestamp.created` has the default too.

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
    // T | null and the plain field: no DDL default on SQLite (filled on insert);
    // no member sizes the column
    expect(sql).not.toContain("DEFAULT");
    expect(sql).toContain('"code" TEXT NOT NULL');

    const row = { pair: [1, "a"], emails: ["a@b.co"], n: 2, code: "abc" };
    await table.insertOne({ id: 1, x: 5, ...row } as any);
    const stored = (await table.findOne({ filter: { id: 1 }, controls: {} } as any)) as any;
    expect(Number(stored.y)).toBeGreaterThan(0);
    expect(stored.created).toBeGreaterThan(0);
    await expect(table.insertOne({ id: 2, ...row, pair: [undefined, "a"] } as any)).rejects.toThrow(
      /pair\.0/,
    );
    driver.close();
  });
});
