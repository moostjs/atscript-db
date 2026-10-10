import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

// Since atscript 0.1.103 `number.timestamp.created | null` carries
// `@db.default.now` on its member and `string.char | string` carries
// `@expect.maxLength 1`. Members are not columns
// (no epoch DEFAULT on a text column, no VARCHAR(1)) — except the one
// non-null member of `T | null`: since 0.1.155 such a field is a nullable
// column of `T`'s type with `T`'s db annotations (its `now` default).
// A tuple is a JSON column.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/union-members.as");
});

describe("PostgresAdapter — union / tuple members in DDL", () => {
  it("CREATE TABLE ignores member annotations, except T | null's db ones", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new PostgresAdapter(driver));
    await space.getTable(fx.UnionMembers).dbAdapter.ensureTable();
    const create = driver.calls
      .filter((c) => c.method === "exec")
      .map((c) => c.sql)
      .find((s) => s.startsWith("CREATE TABLE"));
    const now = "DEFAULT (extract(epoch from now()) * 1000)::bigint";
    expect(create).toBe(
      `CREATE TABLE IF NOT EXISTS "union_members" ("id" DOUBLE PRECISION PRIMARY KEY, "x" BIGINT ${now}, "y" BIGINT ${now}, "pair" JSONB NOT NULL, "emails" JSONB NOT NULL, "n" INTEGER, "code" TEXT NOT NULL, "created" BIGINT NOT NULL ${now})`,
    );
  });
});
