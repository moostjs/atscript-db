import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import dbPlugin from "../plugin";
import { AtscriptDbTable } from "../table/db-table";
import { MockAdapter, prepareFixtures } from "./test-utils";

let VersionedUser: any;
let VersionedOrder: any;
let PlainWidget: any;
let VersionedWithExplicitDefault: any;

beforeAll(async () => {
  await prepareFixtures();
  const mod = await import("./fixtures/version-tables.as");
  VersionedUser = mod.VersionedUser;
  VersionedOrder = mod.VersionedOrder;
  PlainWidget = mod.PlainWidget;
  VersionedWithExplicitDefault = mod.VersionedWithExplicitDefault;
});

// ── Metadata wiring ─────────────────────────────────────────────────────────

describe("@db.column.version → table.versionColumn", () => {
  // WHY: regression guard that the plugin entry is registered and the
  // annotation-scan path inside TableMetadata feeds the public getter that
  // every later phase (decomposer rejection, adapter always-bump, REST meta)
  // reads from.
  it("exposes the annotated field as the version column on the table", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(VersionedUser, adapter);
    expect(table.versionColumn).toBe("version");
  });

  // WHY: downstream layers (SQL builder injecting `version = version + 1`,
  // REST `versionColumn` meta) use this string verbatim. If the @db.column
  // rename isn't honored, OCC silently targets the wrong physical column.
  it("respects @db.column rename when reporting the physical version column", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(VersionedOrder, adapter);
    expect(table.versionColumn).toBe("v");
  });

  // WHY: the feature must be strictly opt-in (locked decision row 1). A
  // missing annotation must surface as `undefined`, not an empty string or
  // any other truthy default, so callers can branch on `!versionColumn`.
  it("returns undefined for tables without @db.column.version", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(PlainWidget, adapter);
    expect(table.versionColumn).toBeUndefined();
  });
});

// ── Implicit DEFAULT 0 wiring (Step 5) ──────────────────────────────────────

describe("@db.column.version → implicit DEFAULT 0", () => {
  // WHY: without this wiring, schema-sync DDL omits DEFAULT 0, ADD COLUMN on
  // an existing table fails (NOT NULL with no default), and new inserts that
  // omit `version` blow up. The whole §4.6 contract rides on this single
  // assignment.
  it("seeds defaultValue { kind: 'value', value: '0' } on the version field descriptor", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(VersionedUser, adapter);
    const fd = table.fieldDescriptors.find((f) => f.path === "version");
    expect(fd?.defaultValue).toEqual({ kind: "value", value: "0" });
  });

  // WHY: the other half of NOT NULL DEFAULT 0 — if the version field were
  // optional, the DDL would emit a nullable column and `NULL + 1 = NULL`
  // would silently break the auto-bump invariant. The validator rejects
  // optional version fields (see compile-time block) so this must hold.
  it("marks the version field descriptor as non-optional", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(VersionedUser, adapter);
    const fd = table.fieldDescriptors.find((f) => f.path === "version");
    expect(fd?.optional).toBe(false);
  });

  // WHY: precedence guard — a caller who explicitly sets @db.default on a
  // versioned column has opted out of the implicit 0. Honor their value
  // (consistent with existing per-annotation precedence; no surprises).
  it("respects an explicit @db.default on a versioned column instead of the implicit 0", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(VersionedWithExplicitDefault, adapter);
    const fd = table.fieldDescriptors.find((f) => f.path === "version");
    expect(fd?.defaultValue).toEqual({ kind: "value", value: "7" });
  });
});

// ── Compile-time validation ─────────────────────────────────────────────────

describe("@db.column.version compile-time validation", () => {
  // WHY: enforces the "at most one version column per table" constraint
  // (proposal §4.1, locked decision row 1) at compile time instead of
  // discovering the violation on the first write through the adapter.
  it("rejects multiple @db.column.version annotations on the same table", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'bad'
      export interface TwoVersions {
        @meta.id
        id: number

        @db.column.version
        v1: number

        @db.column.version
        v2: number
      }
    `);
    expect(
      messages.some((m) => m.includes("@db.column.version") && m.includes("At most one")),
    ).toBe(true);
  });

  // WHY: optional + version is incoherent — a nullable column would emit
  // DDL without NOT NULL, leaving rows where `NULL + 1 = NULL` silently
  // breaks the auto-bump invariant. Catch at compile time, not run time.
  it("rejects @db.column.version on an optional field", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'bad'
      export interface VersionOptional {
        @meta.id
        id: number

        @db.column.version
        version?: number
      }
    `);
    expect(
      messages.some((m) => m.includes("@db.column.version") && m.includes("non-optional")),
    ).toBe(true);
  });

  // WHY: the version column must hold a monotonically incrementing integer
  // — applying the annotation to a string column would produce a runtime
  // type error on the very first auto-bump in the adapter.
  it("rejects @db.column.version on a non-numeric field", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'bad'
      export interface VersionOnString {
        @meta.id
        id: number

        @db.column.version
        version: string
      }
    `);
    expect(
      messages.some(
        (m) => m.includes("@db.column.version") && m.includes("string") && m.includes("number"),
      ),
    ).toBe(true);
  });
});

async function diagnosticsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "version-annotation-diagnostics-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin()],
  });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()].flat().map((message) => message.message);
}
