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

beforeAll(async () => {
  await prepareFixtures();
  const mod = await import("./fixtures/version-tables.as");
  VersionedUser = mod.VersionedUser;
  VersionedOrder = mod.VersionedOrder;
  PlainWidget = mod.PlainWidget;
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
