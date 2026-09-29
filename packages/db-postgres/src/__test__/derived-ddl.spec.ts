import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import type { TDbFieldMeta } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

// `@db.column.derived` on PostgreSQL (since 0.1.141): STORED generated
// columns in CREATE TABLE and ADD COLUMN, and `is_generated` introspection.
// The same DDL runs end to end against PGlite in the release verification.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/derived.as");
});

const execs = (driver: ReturnType<typeof createMockDriver>) =>
  driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);

describe("PostgresAdapter — derived columns", () => {
  it("CREATE TABLE renders each derived field as a typed STORED generated column", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new PostgresAdapter(driver));
    await space.getTable(fx.DvOrder).dbAdapter.ensureTable();
    const create = execs(driver).find((s) => s.startsWith("CREATE TABLE"))!;
    expect(create).toContain(
      `"customerId" TEXT GENERATED ALWAYS AS (CASE jsonb_typeof(("payload")::jsonb #> '{"customer","id"}') WHEN 'string' THEN ("payload")::jsonb #>> '{"customer","id"}' END) STORED`,
    );
    expect(create).toMatch(
      /"vip" BOOLEAN GENERATED ALWAYS AS \(.*"customer","vip".*::boolean.*\) STORED/,
    );
    expect(create).toMatch(/"amount" DOUBLE PRECISION GENERATED ALWAYS AS \(.*"total".*\) STORED/);
    expect(create).toMatch(
      /"region_code" TEXT GENERATED ALWAYS AS \(.*"meta_json".*"region".*\) STORED/,
    );
    // `@db.column.collate 'nocase'` is CITEXT on PostgreSQL, as on a stored column
    expect(create).toMatch(/"tier" CITEXT GENERATED ALWAYS AS/);
    expect(create).not.toMatch(/\) STORED (NOT NULL|DEFAULT)/);
  });

  it("ADD COLUMN uses the same definition", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new PostgresAdapter(driver));
    const table = space.getTable(fx.DvSyncV1);
    const field = table.fieldDescriptors.find((f: TDbFieldMeta) => f.path === "customerId")!;
    await table.dbAdapter.syncColumns!({
      added: [field],
      removed: [],
      renamed: [],
      typeChanged: [],
      nullableChanged: [],
      defaultChanged: [],
      conflicts: [],
    });
    expect(execs(driver)).toEqual([
      expect.stringMatching(
        /^ALTER TABLE "dv_sync" ADD COLUMN "customerId" TEXT GENERATED ALWAYS AS \(.*\) STORED$/,
      ),
    ]);
  });

  it("introspection flags is_generated = ALWAYS", async () => {
    const row = (column_name: string, data_type: string, is_generated: string) => ({
      column_name,
      data_type,
      udt_name: data_type,
      character_maximum_length: null,
      numeric_precision: null,
      numeric_scale: null,
      is_nullable: column_name === "customerId" ? "YES" : "NO",
      column_default: null,
      is_identity: "NO",
      is_generated,
      formatted_type: data_type,
      is_pk: column_name === "id",
    });
    const driver = createMockDriver({
      allResult: (sql) =>
        sql.includes("information_schema.columns")
          ? [
              row("id", "integer", "NEVER"),
              row("payload", "jsonb", "NEVER"),
              row("customerId", "text", "ALWAYS"),
            ]
          : [],
    });
    const space = new DbSpace(() => new PostgresAdapter(driver));
    const columns = await space.getTable(fx.DvSyncV1).dbAdapter.getExistingColumns!();
    expect(columns.map((c) => [c.name, c.generated, c.notnull])).toEqual([
      ["id", undefined, true],
      ["payload", undefined, true],
      ["customerId", true, false],
    ]);
  });
});

describe("PostgresAdapter — COLLATE on ADD COLUMN", () => {
  // Regression: `ADD COLUMN` used to render a native `@db.pg.collate` only
  // when the field ALSO carried a portable `@db.column.collate`, while
  // `CREATE TABLE` always did — one `pgCollateClause` now serves both.
  it("renders a native @db.pg.collate exactly as CREATE TABLE does, with or without a portable collate", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new PostgresAdapter(driver));
    const table = space.getTable(fx.DvOrder);
    const status = table.fieldDescriptors.find((f: TDbFieldMeta) => f.path === "status")!;
    const nativeOnly: TDbFieldMeta = {
      ...status,
      physicalName: "code",
      path: "code",
      type: { ...status.type, metadata: new Map([["db.pg.collate", "C"]]) } as never,
    };
    const both: TDbFieldMeta = {
      ...nativeOnly,
      physicalName: "label",
      path: "label",
      collate: "binary",
    };
    await table.dbAdapter.syncColumns!({
      added: [nativeOnly, both],
      removed: [],
      renamed: [],
      typeChanged: [],
      nullableChanged: [],
      defaultChanged: [],
      conflicts: [],
    });
    expect(execs(driver).filter((s) => s.startsWith("ALTER TABLE"))).toEqual([
      `ALTER TABLE "dv_orders" ADD COLUMN "code" TEXT NOT NULL DEFAULT '' COLLATE "C"`,
      `ALTER TABLE "dv_orders" ADD COLUMN "label" TEXT NOT NULL DEFAULT '' COLLATE "C"`,
    ]);
  });

  it("adds several derived columns in ONE ALTER TABLE (one table rewrite)", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new PostgresAdapter(driver));
    const table = space.getTable(fx.DvOrder);
    const derived = table.fieldDescriptors.filter((f: TDbFieldMeta) => f.derived);
    expect(derived.length).toBeGreaterThan(1);
    await table.dbAdapter.syncColumns!({
      added: derived,
      removed: [],
      renamed: [],
      typeChanged: [],
      nullableChanged: [],
      defaultChanged: [],
      conflicts: [],
    });
    const ddl = execs(driver).filter((s) => s.startsWith("ALTER TABLE"));
    expect(ddl).toHaveLength(1);
    expect(ddl[0]!.match(/ADD COLUMN/g)).toHaveLength(derived.length);
    expect(ddl[0]).toMatch(
      /^ALTER TABLE "dv_orders" ADD COLUMN "customerId" .* STORED, ADD COLUMN /,
    );
  });
});
