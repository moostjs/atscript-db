import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { DbError } from "../db-error";
import dbPlugin from "../plugin";
import { AtscriptDbTable } from "../table/db-table";
import { withOptimisticRetry } from "../with-optimistic-retry";
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

  // WHY: `versionColumn` is the consumer-facing key ($cas, write bodies, rows
  // read back, REST `/meta`) — all of which speak LOGICAL field names. A
  // @db.column rename moves only the storage column, which adapters reach
  // through `versionColumnPhysical`. Mixing the two broke OCC end to end
  // for renamed version fields (≤ 0.1.140 returned the physical name here).
  it("reports the logical field for a @db.column-renamed version column", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(VersionedOrder, adapter);
    expect(table.versionColumn).toBe("revision");
    expect(table.versionColumnPhysical).toBe("v");
  });

  // WHY: un-renamed tables keep logical == physical, so every adapter and
  // REST path behaves byte-identically to before the split.
  it("reports the same name for both getters when the field is not renamed", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(VersionedUser, adapter);
    expect(table.versionColumn).toBe("version");
    expect(table.versionColumnPhysical).toBe("version");
  });

  // WHY: the feature must be strictly opt-in (locked decision row 1). A
  // missing annotation must surface as `undefined`, not an empty string or
  // any other truthy default, so callers can branch on `!versionColumn`.
  it("returns undefined for tables without @db.column.version", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(PlainWidget, adapter);
    expect(table.versionColumn).toBeUndefined();
    expect(table.versionColumnPhysical).toBeUndefined();
  });
});

// ── Renamed version column: logical at the table API, physical at the adapter ──

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DbError);
  return (err as DbError).code;
}

describe("@db.column-renamed version column (logical `revision` → physical `v`)", () => {
  function makeOrders(rows: Array<Record<string, unknown>> = []) {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(VersionedOrder, adapter);
    adapter.store.set(table.tableName, rows);
    return { table, adapter };
  }

  // WHY: separateCas matches the `$cas` key against `versionColumn`; with the
  // logical name the SDK operator lifts, and the adapter receives only the
  // numeric expectedVersion (it CASes on the physical column itself).
  it("updateOne lifts `$cas: { revision }` into the adapter's expectedVersion", async () => {
    const { table, adapter } = makeOrders();
    const updateOne = vi.spyOn(adapter, "updateOne");
    await table.updateOne({ id: 1, status: "paid", $cas: { revision: 2 } } as any);
    const [filter, data, , expectedVersion] = updateOne.mock.calls[0]! as unknown[];
    expect(filter).toEqual({ id: 1 });
    expect(data).toEqual({ status: "paid" });
    expect(expectedVersion).toBe(2);
  });

  // WHY: the physical name is storage detail — a `$cas` keyed by it is a key
  // mismatch, same as any other wrong key (fails loud, never silently drops).
  it("rejects `$cas` keyed by the physical column name", async () => {
    const { table } = makeOrders();
    expect(await codeOf(table.updateOne({ id: 1, $cas: { v: 2 } } as any))).toBe("INVALID_QUERY");
  });

  // WHY: bulkReplace/replaceOne share the same lift — per-row expectedVersion
  // reaches the adapter's replaceOne as its third argument.
  it("replaceOne lifts `$cas: { revision }` into the adapter's expectedVersion", async () => {
    const { table, adapter } = makeOrders();
    const replaceOne = vi.spyOn(adapter, "replaceOne");
    await table.replaceOne({ id: 1, status: "paid", $cas: { revision: 5 } } as any);
    const [, data, expectedVersion] = replaceOne.mock.calls[0]! as unknown[];
    expect(data).not.toHaveProperty("v");
    expect(data).not.toHaveProperty("revision");
    expect(expectedVersion).toBe(5);
  });

  // WHY: assertNoVersionWrites runs on the LOGICAL payload — before the
  // physical-name fix it looked for `v`, so a `revision` write slipped
  // through into the SET list (SQL `SET v = ?, v = v + 1`, Mongo $set+$inc).
  it.each([
    ["updateOne", (t: AtscriptDbTable) => t.updateOne({ id: 1, revision: 9 } as any)],
    [
      "updateOne ($inc)",
      (t: AtscriptDbTable) => t.updateOne({ id: 1, revision: { $inc: 1 } } as any),
    ],
    [
      "replaceOne",
      (t: AtscriptDbTable) => t.replaceOne({ id: 1, status: "x", revision: 9 } as any),
    ],
    ["bulkUpdate", (t: AtscriptDbTable) => t.bulkUpdate([{ id: 1, revision: 9 }] as any)],
    [
      "bulkReplace",
      (t: AtscriptDbTable) => t.bulkReplace([{ id: 1, status: "x", revision: 9 }] as any),
    ],
    [
      "updateMany",
      (t: AtscriptDbTable) => t.updateMany({ status: "new" } as any, { revision: 9 } as any),
    ],
  ])("%s rejects a direct write to the logical version field", async (_name, run) => {
    const { table, adapter } = makeOrders([{ id: 1, status: "new", v: 2 }]);
    expect(await codeOf(run(table))).toBe("VERSION_COLUMN_WRITE");
    expect(adapter.calls.filter((c) => c.method !== "count" && c.method !== "findOne")).toEqual([]);
  });

  // WHY: withOptimisticRetry reads `row[versionColumn]` off a LOGICAL row
  // (findOne maps `v` → `revision`) and re-emits `$cas: { [versionColumn] }`.
  // With the physical name it read `undefined` and sent `$cas: { v }`, which
  // separateCas then rejected — the helper was unusable on renamed tables.
  it("withOptimisticRetry reads the logical version and CASes on it", async () => {
    const { table, adapter } = makeOrders([{ id: 1, status: "new", v: 2 }]);
    const updateOne = vi.spyOn(adapter, "updateOne");
    const seen: unknown[] = [];
    const result = await withOptimisticRetry(table, { id: 1 }, (row) => {
      seen.push(row.revision);
      return { status: "paid" };
    });
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    expect(seen).toEqual([2]);
    const [, data, , expectedVersion] = updateOne.mock.calls[0]! as unknown[];
    expect(data).toEqual({ status: "paid" });
    expect(expectedVersion).toBe(2);
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
