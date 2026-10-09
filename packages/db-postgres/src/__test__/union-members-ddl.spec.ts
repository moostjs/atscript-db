import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

// Since atscript 0.1.103 `number.timestamp.created | null` carries
// `@db.default.now` on its member and `string.char | string` carries
// `@expect.maxLength 1`. Members are not columns: the DDL is the same as
// with atscript 0.1.102 (no epoch DEFAULT on a text column, no VARCHAR(1)).

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/union-members.as");
});

describe("PostgresAdapter — union / tuple members in DDL", () => {
  it("CREATE TABLE ignores member annotations", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new PostgresAdapter(driver));
    await space.getTable(fx.UnionMembers).dbAdapter.ensureTable();
    const create = driver.calls
      .filter((c) => c.method === "exec")
      .map((c) => c.sql)
      .find((s) => s.startsWith("CREATE TABLE"));
    expect(create).toBe(
      'CREATE TABLE IF NOT EXISTS "union_members" ("id" DOUBLE PRECISION PRIMARY KEY, "x" TEXT NOT NULL, "y" TEXT, "pair" TEXT NOT NULL, "emails" JSONB NOT NULL, "n" TEXT NOT NULL, "code" TEXT NOT NULL, "created" DOUBLE PRECISION NOT NULL)',
    );
  });
});
