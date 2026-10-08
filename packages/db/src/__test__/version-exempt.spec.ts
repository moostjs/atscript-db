import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import dbPlugin from "../plugin";
import { isVersionExemptPatch } from "../patch/version-exempt";
import { computeTableHash, computeTableSnapshot } from "../schema/schema-hash";
import { DbSpace } from "../table/db-space";
import { AtscriptDbTable } from "../table/db-table";
import { MockAdapter, prepareFixtures } from "./test-utils";

// `@db.column.version.exempt` (since 0.1.150): a patch writing ONLY exempt
// fields neither bumps the version nor adds a version predicate.

let VxRecord: any;
let VxPlain: any;

beforeAll(async () => {
  await prepareFixtures();
  const v = await import("./fixtures/version-exempt.as");
  VxRecord = v.VxRecord;
  VxPlain = v.VxPlain;
});

class NativeMock extends MockAdapter {
  override supportsNativePatch(): boolean {
    return true;
  }
  override supportsNestedObjects(): boolean {
    return true;
  }
  async nativePatch(...args: any[]) {
    this.record("nativePatch", ...args);
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

function makeTable(type: any, adapter: MockAdapter = new MockAdapter()) {
  const table = new AtscriptDbTable(type, adapter);
  adapter.store.set(table.tableName, [{ id: 1 }, { id: 2 }]);
  return { table, adapter };
}

const lastCall = (adapter: MockAdapter, method: string) =>
  adapter.calls.findLast((c) => c.method === method)!;

describe("versionExemptFields metadata", () => {
  it("collects declared paths and the upward closure", () => {
    const { table } = makeTable(VxRecord);
    const fields = table.versionExemptFields;
    for (const p of ["score", "hits", "metrics", "stats", "tags", "mixed.cached"]) {
      expect(fields.has(p), p).toBe(true);
    }
    expect(fields.has("mixed")).toBe(false);
    expect(fields.has("title")).toBe(false);
    expect(fields.has("version")).toBe(false);
  });

  it("is empty on a table without a version column", () => {
    const { table } = makeTable(VxPlain);
    expect(table.versionExemptFields.size).toBe(0);
  });
});

describe("isVersionExemptPatch truth table", () => {
  const t = () => makeTable(VxRecord).table as AtscriptDbTable;

  it.each([
    ["{score}", { score: 1 }, true],
    ["{score, title}", { score: 1, title: "x" }, false],
    ["{hits: $inc}", { hits: { $inc: 1 } }, true],
    ["{metrics: {impact}}", { metrics: { impact: 1 } }, true],
    ["{stats: {views}} (closure)", { stats: { views: 1 } }, true],
    ["{mixed: {cached}}", { mixed: { cached: 1 } }, true],
    ["{mixed: {label}}", { mixed: { label: "x" } }, false],
    ["{mixed: {cached, label}}", { mixed: { cached: 1, label: "x" } }, false],
    ["{mixed: {}}", { mixed: {} }, false],
    ["{tags: {$insert}}", { tags: { $insert: ["a"] } }, true],
    ["{}", {}, false],
    ["PK only", { id: 1 }, false],
    ["PK + exempt", { id: 1, score: 2 }, true],
    ["PK + non-exempt", { id: 1, title: "x" }, false],
  ] as const)("%s → %s", (_n, data, expected) => {
    expect(isVersionExemptPatch(data as any, t())).toBe(expected);
  });

  it("is false on a table with no exempt fields", () => {
    const { table: plain } = makeTable(VxPlain);
    expect(isVersionExemptPatch({ score: 1 }, plain as AtscriptDbTable)).toBe(false);
  });
});

describe("adapter hand-off (generic path)", () => {
  it("exempt-only updateOne → keepVersion, no expectedVersion", async () => {
    const { table, adapter } = makeTable(VxRecord);
    await table.updateOne({ id: 1, score: 5 } as any);
    const [, , , expectedVersion, opts] = lastCall(adapter, "updateOne").args.slice(0);
    expect(expectedVersion).toBeUndefined();
    expect(opts).toEqual({ keepVersion: true });
  });

  it("mixed updateOne → no opts", async () => {
    const { table, adapter } = makeTable(VxRecord);
    await table.updateOne({ id: 1, score: 5, title: "t" } as any);
    expect(lastCall(adapter, "updateOne").args[4]).toBeUndefined();
  });

  it("$cas + exempt-only → expectedVersion, no opts (Q1)", async () => {
    const { table, adapter } = makeTable(VxRecord);
    await table.updateOne({ id: 1, score: 5, $cas: { version: 3 } } as any);
    const args = lastCall(adapter, "updateOne").args;
    expect(args[3]).toBe(3);
    expect(args[4]).toBeUndefined();
  });

  it("bulkUpdate decides per item", async () => {
    const { table, adapter } = makeTable(VxRecord);
    await table.bulkUpdate([
      { id: 1, score: 1 },
      { id: 2, title: "x" },
    ] as any);
    const calls = adapter.calls.filter((c) => c.method === "updateOne");
    expect(calls.map((c) => c.args[4])).toEqual([{ keepVersion: true }, undefined]);
  });

  it("exempt nested object (closure) is flattened and kept", async () => {
    const { table, adapter } = makeTable(VxRecord);
    await table.updateOne({ id: 1, stats: { views: 2 } } as any);
    expect(lastCall(adapter, "updateOne").args[4]).toEqual({ keepVersion: true });
  });

  it("updateMany: exempt → keep, mixed → none, empty → count only", async () => {
    const { table, adapter } = makeTable(VxRecord);
    await table.updateMany({ status: "open" } as any, { score: 1 } as any);
    expect(lastCall(adapter, "updateMany").args[3]).toEqual({ keepVersion: true });

    await table.updateMany({ status: "open" } as any, { title: "x" } as any);
    expect(lastCall(adapter, "updateMany").args[3]).toBeUndefined();

    adapter.calls.length = 0;
    await table.updateMany({ status: "open" } as any, {} as any);
    expect(adapter.calls.some((c) => c.method === "updateMany")).toBe(false);
  });

  it("touchMany always bumps (no opts)", async () => {
    const { table, adapter } = makeTable(VxRecord);
    adapter.store.set(table.tableName, [{ id: 1, version: 0 }]);
    await table.touchMany([{ id: 1, version: 0 }] as any);
    const call = lastCall(adapter, "updateMany");
    expect(call.args[3]).toBeUndefined();
  });

  it("table without a version column never hands off keepVersion", async () => {
    const { table, adapter } = makeTable(VxPlain);
    await table.updateOne({ id: 1, score: 5 } as any);
    expect(lastCall(adapter, "updateOne").args[4]).toBeUndefined();
  });

  it("replaceOne is unaffected", async () => {
    const { table, adapter } = makeTable(VxRecord);
    await table.replaceOne({
      id: 1,
      title: "t",
      status: "s",
      score: 1,
      hits: 1,
      metrics: { impact: 1 },
      stats: { views: 1 },
      mixed: { cached: 1, label: "l" },
      tags: [],
    } as any);
    expect(lastCall(adapter, "replaceOne").args.length).toBe(2);
  });
});

describe("adapter hand-off (native patch path)", () => {
  it("nativePatch gets keepVersion for exempt-only, none otherwise", async () => {
    const { table, adapter } = makeTable(VxRecord, new NativeMock());
    await table.updateOne({ id: 1, score: 5 } as any);
    expect(lastCall(adapter, "nativePatch").args[4]).toEqual({ keepVersion: true });
    await table.updateOne({ id: 1, title: "x" } as any);
    expect(lastCall(adapter, "nativePatch").args[4]).toBeUndefined();
    await table.updateOne({ id: 1, score: 5, $cas: { version: 2 } } as any);
    const args = lastCall(adapter, "nativePatch").args;
    expect(args[3]).toBe(2);
    expect(args[4]).toBeUndefined();
  });
});

// ── Runtime mirror ──────────────────────────────────────────────────────────

function leaf(designType: string, metadata: Array<[string, unknown]> = [], kind = "") {
  return {
    __is_atscript_annotated_type: true,
    type: { kind, designType, tags: new Set<string>() },
    metadata: new Map(metadata),
  } as any;
}
function obj(props: Record<string, any>, metadata: Array<[string, unknown]> = []) {
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "object", props: new Map(Object.entries(props)) },
    metadata: new Map(metadata),
  } as any;
}
let seq = 0;
function buildRaw(props: Record<string, any>) {
  const type = obj(props, [["db.table", `vx_runtime_${seq++}`]]);
  const table = new DbSpace(() => new MockAdapter()).getTable(type);
  table.getMetadata();
  return table;
}
const EX: [string, unknown] = ["db.column.version.exempt", true];
const idf = () => leaf("number", [["meta.id", true]]);
const verf = (extra: Array<[string, unknown]> = []) =>
  leaf("number", [["db.column.version", true], ...extra]);

describe("runtime mirror of the placement rules", () => {
  it("E1 — the version column itself", () => {
    expect(() => buildRaw({ id: idf(), v: verf([EX]) })).toThrow(/version column itself/);
  });
  it("E2 — a primary key", () => {
    expect(() => buildRaw({ id: leaf("number", [["meta.id", true], EX]), v: verf() })).toThrow(
      /primary key/,
    );
  });
  it("E3 — a navigation field", () => {
    expect(() =>
      buildRaw({
        id: idf(),
        v: verf(),
        rel: obj({ x: leaf("number") }, [["db.rel.to", { alias: "a" }], EX]),
      }),
    ).toThrow(/navigation field/);
  });
  it("E4 — inside a @db.json field", () => {
    expect(() =>
      buildRaw({
        id: idf(),
        v: verf(),
        data: obj({ x: leaf("number", [EX]) }, [["db.json", true]]),
      }),
    ).toThrow(/@db\.json/);
  });
  it("E5 — inside an array of objects", () => {
    const arr = {
      __is_atscript_annotated_type: true,
      type: { kind: "array", of: obj({ x: leaf("number", [EX]) }) },
      metadata: new Map(),
    } as any;
    expect(() => buildRaw({ id: idf(), v: verf(), items: arr })).toThrow(/array field "items"/);
  });
  it("the array field itself may be marked", () => {
    const arr = {
      __is_atscript_annotated_type: true,
      type: { kind: "array", of: leaf("string") },
      metadata: new Map([EX]),
    } as any;
    expect(buildRaw({ id: idf(), v: verf(), tags: arr }).versionExemptFields.has("tags")).toBe(
      true,
    );
  });
  it("E6 — a derived column", () => {
    expect(() =>
      buildRaw({ id: idf(), v: verf(), d: leaf("number", [["db.column.derived", true], EX]) }),
    ).toThrow(/cannot coexist with @db\.column\.version\.exempt/);
  });
  it("a table without a version column ignores the annotation", () => {
    const t = buildRaw({ id: idf(), s: leaf("number", [EX]) });
    expect(t.versionExemptFields.size).toBe(0);
  });
});

describe("schema hash", () => {
  it("is unaffected by the annotation (no drift, no sync)", () => {
    const hashOf = (extra: Array<[string, unknown]>) => {
      const type = obj(
        {
          id: idf(),
          v: verf(),
          score: leaf("number", extra),
          stats: obj({ views: leaf("number", extra) }),
        },
        [["db.table", "vx_hash"]],
      );
      const t = new DbSpace(() => new MockAdapter()).getTable(type);
      return computeTableHash(computeTableSnapshot(t, (f) => f.designType.toUpperCase()));
    };
    expect(hashOf([EX])).toBe(hashOf([]));
  });
});

// ── Compile-time diagnostics ────────────────────────────────────────────────

async function diagnosticsFor(source: string) {
  const rootDir = mkdtempSync(join(tmpdir(), "version-exempt-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({ rootDir, entries: ["fixture.as"], plugins: [tsPlugin(), dbPlugin()] });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()]
    .flat()
    .map((m) => ({ message: m.message, severity: m.severity as number }));
}

const table = (body: string, version = true) => `
@db.table 'vxd_t'
export interface VxdT {
    @meta.id
    id: number
    ${version ? "@db.column.version\n    version: number.int" : ""}
    ${body}
}
`;

describe("compile-time diagnostics", () => {
  it("E1 — on the version column", async () => {
    const d = await diagnosticsFor(`
@db.table 'vxd_t'
export interface VxdT {
    @meta.id
    id: number
    @db.column.version
    @db.column.version.exempt
    version: number.int
}`);
    expect(d).toContainEqual(
      expect.objectContaining({
        severity: 1,
        message: expect.stringContaining("version column itself"),
      }),
    );
  });

  it("E2 — on a primary key", async () => {
    const d = await diagnosticsFor(`
@db.table 'vxd_t'
export interface VxdT {
    @meta.id
    @db.column.version.exempt
    id: number
    @db.column.version
    version: number.int
}`);
    expect(d.some((m) => m.severity === 1 && /primary key/.test(m.message))).toBe(true);
  });

  it("E3 — on a nav field", async () => {
    const d = await diagnosticsFor(`
@db.table 'vxd_other'
export interface VxdOther {
    @meta.id
    id: number
}
@db.table 'vxd_t'
export interface VxdT {
    @meta.id
    id: number
    @db.column.version
    version: number.int
    @db.rel.FK
    otherId: VxdOther.id
    @db.rel.to
    @db.column.version.exempt
    other: VxdOther
}`);
    expect(d.some((m) => m.severity === 1 && /navigation field/.test(m.message))).toBe(true);
  });

  it("E4 — below a @db.json field", async () => {
    const d = await diagnosticsFor(
      table(`@db.json
    payload: {
        @db.column.version.exempt
        x: number
    }`),
    );
    expect(d.some((m) => m.severity === 1 && /@db\.json field 'payload'/.test(m.message))).toBe(
      true,
    );
  });

  it("E5 — below an array of objects", async () => {
    const d = await diagnosticsFor(
      table(`items: {
        @db.column.version.exempt
        x: number
    }[]`),
    );
    expect(d.some((m) => m.severity === 1 && /array field 'items'/.test(m.message))).toBe(true);
  });

  it("E6 — with @db.column.derived", async () => {
    const d = await diagnosticsFor(`
@db.table 'vxd_t'
export interface VxdT {
    @meta.id
    id: number
    @db.column.version
    version: number.int
    @db.json
    payload: { n: number }
    @db.column.derived
    @db.column.version.exempt
    n: VxdT.payload.n
}`);
    expect(
      d.some(
        (m) =>
          m.severity === 1 && /cannot coexist with @db\.column\.version\.exempt/.test(m.message),
      ),
    ).toBe(true);
  });

  it("W1 — table without a version column", async () => {
    const d = await diagnosticsFor(table(`@db.column.version.exempt\n    score: number`, false));
    expect(d).toContainEqual(
      expect.objectContaining({
        severity: 2,
        message: expect.stringContaining("declares no @db.column.version"),
      }),
    );
  });

  it("W2 — with @db.ignore", async () => {
    const d = await diagnosticsFor(
      table(`@db.ignore\n    @db.column.version.exempt\n    score: number`),
    );
    expect(d).toContainEqual(
      expect.objectContaining({ severity: 2, message: expect.stringContaining("ignored field") }),
    );
  });

  it("accepts the valid placements without diagnostics", async () => {
    const d = await diagnosticsFor(`
@db.table 'vxd_other'
export interface VxdOther {
    @meta.id
    id: number
}
@db.table 'vxd_t'
export interface VxdT {
    @meta.id
    id: number
    @db.column.version
    version: number.int
    @db.column.version.exempt
    score: number
    @db.column.version.exempt
    stats: { views: number }
    nested: {
        @db.column.version.exempt
        hits: number
    }
    @db.column.version.exempt
    @db.json
    blob: { a: number }
    @db.column.version.exempt
    tags: string[]
    @db.column.version.exempt
    @db.rel.FK
    otherId: VxdOther.id
    @db.rel.to
    other: VxdOther
}`);
    expect(d).toEqual([]);
  });

  it("keeps resolving @db.column.version itself", async () => {
    const d = await diagnosticsFor(table(``));
    expect(d).toEqual([]);
  });
});

// ── Annotation tree ($self + child) ─────────────────────────────────────────

describe("annotation tree", () => {
  it("resolves both @db.column.version ($self) and @db.column.version.exempt", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "version-exempt-tree-"));
    writeFileSync(join(rootDir, "tree.as"), table(`@db.column.version.exempt\n    score: number`));
    const repo = await build({
      rootDir,
      entries: ["tree.as"],
      plugins: [tsPlugin(), dbPlugin()],
    });
    const doc = repo.getDoc(`file://${join(rootDir, "tree.as")}`)!;
    expect(doc.getDiagMessages().map((m) => m.message)).toEqual([]);
    expect(doc.resolveAnnotation("db.column.version")).toBeDefined();
    expect(doc.resolveAnnotation("db.column.version.exempt")).toBeDefined();
  });
});
