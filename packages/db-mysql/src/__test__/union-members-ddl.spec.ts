import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

// Since atscript 0.1.103 `number.timestamp.created | null` carries
// `@db.default.now` on its member and `string.char | string` carries
// `@expect.maxLength 1`. Members are not columns: the DDL is the same as
// with atscript 0.1.102 (no DEFAULT CURRENT_TIMESTAMP on a text column, no VARCHAR(1)).
// Since 0.1.155 a `T | null` field is a nullable column of `T`'s type and a
// tuple a JSON column.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/union-members.as");
});

describe("MysqlAdapter — union / tuple members in DDL", () => {
  it("CREATE TABLE ignores member annotations", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new MysqlAdapter(driver));
    await space.getTable(fx.UnionMembers).dbAdapter.ensureTable();
    const create = driver.calls
      .filter((c) => c.method === "exec")
      .map((c) => c.sql)
      .find((s) => s.startsWith("CREATE TABLE"));
    expect(create).toBe(
      "CREATE TABLE IF NOT EXISTS `union_members` (`id` DOUBLE PRIMARY KEY, `x` DOUBLE, `y` DOUBLE, `pair` JSON NOT NULL, `emails` JSON NOT NULL, `n` INT, `code` TEXT NOT NULL, `created` DOUBLE NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
  });
});
