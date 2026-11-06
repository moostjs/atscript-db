import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

// `@db.default 0` / `true` / `"active"` / `10.50` render the same DDL
// DEFAULT as the string spelling (`@db.default "0"` …).

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/typed-defaults.as");
});

describe("PostgresAdapter — typed @db.default literals", () => {
  it("CREATE TABLE renders each literal as a typed DEFAULT", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new PostgresAdapter(driver));
    await space.getTable(fx.TypedDefaults).dbAdapter.ensureTable();
    const create = driver.calls
      .filter((c) => c.method === "exec")
      .map((c) => c.sql)
      .find((s) => s.startsWith("CREATE TABLE"));
    expect(create).toMatchInlineSnapshot(
      `"CREATE TABLE IF NOT EXISTS "typed_defaults" ("id" DOUBLE PRECISION PRIMARY KEY, "attempts" INTEGER NOT NULL DEFAULT 0, "delta" DOUBLE PRECISION NOT NULL DEFAULT -1.5, "enabled" BOOLEAN NOT NULL DEFAULT true, "archived" BOOLEAN NOT NULL DEFAULT false, "status" VARCHAR(255) NOT NULL DEFAULT 'active', "price" NUMERIC(10,2) NOT NULL DEFAULT 10.5)"`,
    );
  });
});

describe("PostgresAdapter — a @db.default under @normalize.*", () => {
  // A row the database fills (a write outside the SDK, an added column's
  // existing rows) holds what an insert through the table stores: the
  // normalized default, not the raw literal.
  it("CREATE TABLE and ADD COLUMN emit the normalized DEFAULT", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new PostgresAdapter(driver));
    const table = space.getTable(fx.NormalizedDefaults);
    await table.dbAdapter.ensureTable();
    const code = table.fieldDescriptors.find((f: any) => f.path === "code")!;
    await (table.dbAdapter as any).syncColumns({ added: [code], removed: [], typeChanged: [] });
    const ddl = driver.calls.map((c) => c.sql).filter((s) => /CREATE TABLE|ADD COLUMN/.test(s));
    expect(ddl).toHaveLength(2);
    for (const sql of ddl) expect(sql).toContain("DEFAULT 'PENDING'");
  });
});
