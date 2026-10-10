import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

// Since atscript 0.1.103 `number.timestamp.created | null` carries
// `@db.default.now` on its member and `string.char | string` carries
// `@expect.maxLength 1`. Members are not columns (except the one non-null
// member of `T | null`, whose db annotations apply: its `now` default): the DDL is the same as
// with atscript 0.1.102 (no DEFAULT CURRENT_TIMESTAMP on a text column, no VARCHAR(1)).

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/union-members.as");
});

describe("MysqlAdapter — union / tuple members in DDL", () => {
  it("CREATE TABLE ignores member annotations, except T | null's db ones", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new MysqlAdapter(driver));
    await space.getTable(fx.UnionMembers).dbAdapter.ensureTable();
    const create = driver.calls
      .filter((c) => c.method === "exec")
      .map((c) => c.sql)
      .find((s) => s.startsWith("CREATE TABLE"));
    const column = (name: string) =>
      create!.split(", ").find((c) => c.startsWith("`" + name + "`"))!;
    expect(column("created")).toContain("`created` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
    for (const name of ["x", "y"])
      expect(column(name), name).toContain("DEFAULT CURRENT_TIMESTAMP");
    for (const name of ["pair", "n", "code"]) expect(column(name), name).not.toContain("DEFAULT");
    expect(column("code")).toBe("`code` TEXT NOT NULL");
  });
});
