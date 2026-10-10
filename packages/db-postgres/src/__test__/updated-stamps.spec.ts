import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable, DbSpace } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// `number.timestamp.updated` (atscript 0.1.106) is a `@db.default.now` column
// (BIGINT epoch ms, DEFAULT now) that every UPDATE statement sets — the SDK
// writes the time, PostgreSQL has no ON UPDATE.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/updated-stamps.as");
});

const now = "DEFAULT (extract(epoch from now()) * 1000)::bigint";

describe("[postgres] number.timestamp.updated", () => {
  it("CREATE TABLE: BIGINT with the now default, like number.timestamp.created", async () => {
    const driver = createMockDriver();
    await new DbSpace(() => new PostgresAdapter(driver)).getTable(fx.UpdDoc).ensureTable();
    const create = driver.calls.map((c) => c.sql).find((s) => s.startsWith("CREATE TABLE"));
    expect(create).toBe(
      `CREATE TABLE IF NOT EXISTS "upd_docs" ("id" DOUBLE PRECISION PRIMARY KEY, "title" TEXT, "updatedAt" BIGINT NOT NULL ${now}, "aliased" BIGINT NOT NULL ${now}, "nullable" BIGINT ${now}, "audit__note" TEXT, "audit__at" BIGINT NOT NULL ${now})`,
    );
  });

  it("an earlier DOUBLE PRECISION column converts to BIGINT (rounded)", async () => {
    const driver = createMockDriver();
    const adapter = new PostgresAdapter(driver);
    const table = new AtscriptDbTable(fx.UpdAfter, adapter);
    const field = table.fieldDescriptors.find((f) => f.path === "updatedAt")!;
    await adapter.syncColumns({
      added: [],
      removed: [],
      renamed: [],
      typeChanged: [{ field, existingType: "DOUBLE PRECISION" }],
      nullableChanged: [],
      defaultChanged: [],
      conflicts: [],
    } as any);
    expect(driver.calls.filter((c) => c.method === "exec").map((c) => c.sql)).toEqual([
      'ALTER TABLE "upd_upgrade" ALTER COLUMN "updatedAt" TYPE BIGINT USING round("updatedAt")::bigint',
    ]);
  });

  it("a filtered updateMany sets the time in the UPDATE statement", async () => {
    const driver = createMockDriver();
    const table = new DbSpace(() => new PostgresAdapter(driver)).getTable(fx.UpdDoc);
    const before = Date.now();
    await table.updateMany({ title: "a" } as any, { title: "b", updatedAt: 1 } as any);
    const update = driver.calls.find((c) => c.sql.startsWith("UPDATE"))!;
    expect(update.sql).toBe(
      'UPDATE "upd_docs" SET "title" = $1, "updatedAt" = $2, "aliased" = $3, "nullable" = $4 WHERE "title" = $5',
    );
    const [, at, aliased, nullable] = update.params as number[];
    expect(at).toBeGreaterThanOrEqual(before);
    expect([aliased, nullable]).toEqual([at, at]);
  });
});
