import { isDeepStrictEqual } from "node:util";

import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace, RelationalFieldMapper } from "@atscript/db";
import type { TableMetadata } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// The compiled per-table read plan of RelationalFieldMapper.reconstructFromRead
// (since 0.1.151) must produce exactly what the per-row algorithm it replaced
// produced: same values, same key order, JSON parsed only from strings, the
// same parent-collapse order, `null` vs `{}` for collapsed parents. The
// reference below is that algorithm, verbatim.

function toBool(value: unknown): unknown {
  return value === null || value === undefined ? value : !!value;
}
function toDecimalString(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  return typeof value === "number" ? String(value) : value;
}
function setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (current[part] === undefined || current[part] === null) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}
function reconstructNullParent(
  obj: Record<string, unknown>,
  parentPath: string,
  meta: TableMetadata,
): void {
  const parts = parentPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]!] === undefined || current[parts[i]!] === null) return;
    current = current[parts[i]!] as Record<string, unknown>;
  }
  const lastPart = parts[parts.length - 1]!;
  const parentObj = current[lastPart];
  if (typeof parentObj !== "object" || parentObj === null) return;
  let allNull = true;
  for (const k of Object.keys(parentObj as Record<string, unknown>)) {
    const v = (parentObj as Record<string, unknown>)[k];
    if (v !== null && v !== undefined) {
      allNull = false;
      break;
    }
  }
  if (allNull) current[lastPart] = meta.flatMap?.get(parentPath)?.optional ? null : {};
}
/** The pre-0.1.151 full-mapping branch of reconstructFromRead. */
function legacyReconstruct(row: Record<string, unknown>, meta: TableMetadata) {
  const result: Record<string, unknown> = {};
  const fromFmts = meta.fromStorageFormatters;
  for (const physical of Object.keys(row)) {
    const fd = meta.leafByPhysical.get(physical);
    if (!fd) {
      result[physical] = row[physical];
      continue;
    }
    let raw = row[physical];
    const fromFmt = fromFmts?.get(physical);
    if (fromFmt && raw !== null && raw !== undefined) raw = fromFmt(raw);
    const value =
      fd.designType === "boolean"
        ? toBool(raw)
        : fd.designType === "decimal"
          ? toDecimalString(raw)
          : raw;
    if (fd.storage === "json") {
      setNestedValue(result, fd.path, typeof value === "string" ? JSON.parse(value) : value);
    } else if (fd.storage === "flattened") {
      setNestedValue(result, fd.path, value);
    } else {
      result[fd.path] = value;
    }
  }
  for (const parentPath of meta.flattenedParents) reconstructNullParent(result, parentPath, meta);
  return result;
}

/** Deterministic PRNG (mulberry32) — reproducible fuzz rows. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function storedValue(meta: TableMetadata, physical: string, r: () => number): unknown {
  const fd = meta.leafByPhysical.get(physical)!;
  const roll = r();
  if (roll < 0.25) return null;
  if (roll < 0.3) return undefined;
  // A column with an adapter fromStorage formatter (vector blobs, …) gets a
  // number — formatters of the fixture under test are swapped in separately.
  if (meta.fromStorageFormatters?.has(physical)) return 1;
  if (fd.storage === "json") {
    const pick = r();
    if (pick < 0.4) return JSON.stringify({ a: 1, b: [1, "x"], c: { d: null } });
    if (pick < 0.6) return JSON.stringify([1, 2, 3]);
    if (pick < 0.7) return JSON.stringify("str");
    if (pick < 0.8) return 42; // a non-string stays as is
    return JSON.stringify(null);
  }
  switch (fd.designType) {
    case "boolean":
      return r() < 0.5 ? 0 : 1;
    case "decimal":
      return r() < 0.5 ? 12.5 : "7.25";
    case "number":
      return Math.floor(r() * 1000);
    default:
      return `v${Math.floor(r() * 1000)}`;
  }
}

/** A physical row: random subset of the columns (random order), plus an unknown column sometimes. */
function fuzzRow(meta: TableMetadata, r: () => number): Record<string, unknown> {
  const cols = [...meta.leafByPhysical.keys()];
  for (let i = cols.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [cols[i], cols[j]] = [cols[j]!, cols[i]!];
  }
  const row: Record<string, unknown> = {};
  for (const col of cols) {
    if (r() < 0.1) continue; // projected away
    row[col] = storedValue(meta, col, r);
  }
  if (r() < 0.2) row.__extra = "x"; // e.g. a partition row number / join key
  return row;
}

/** Deep equality including the key order of every object. */
function sameShape(a: unknown, b: unknown): boolean {
  if (!isDeepStrictEqual(a, b)) return false;
  if (a && typeof a === "object" && b && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.join("\0") !== kb.join("\0")) return false;
    return ka.every((k) =>
      sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return true;
}

const FIXTURES = [
  "test-table",
  "guard-fixtures",
  "view-json",
  "views",
  "view-chain",
  "derived",
  "agg-orders",
  "with-controls",
  "with-join-keys",
  "rel-filter",
  "undefined-props",
  "typefix",
] as const;

let metas: Array<{ name: string; meta: TableMetadata }> = [];

beforeAll(async () => {
  await prepareFixtures();
  const space = new DbSpace(() => new SqliteAdapter(new BetterSqlite3Driver(":memory:")));
  for (const file of FIXTURES) {
    const mod = (await import(`./fixtures/${file}.as`)) as Record<string, any>;
    for (const [name, type] of Object.entries(mod)) {
      const m = type?.metadata;
      if (!m?.has?.("db.table") && !m?.has?.("db.view") && !m?.has?.("db.view.for")) continue;
      const meta = (space.get(type) as any).getMetadata() as TableMetadata;
      if (meta.requiresMappings && !meta.onlyColumnRenames) metas.push({ name, meta });
    }
  }
});

describe("relational read plan — equivalence with the per-row algorithm", () => {
  it("covers flattened, json, optional-parent and boolean fixtures", () => {
    expect(metas.length).toBeGreaterThan(5);
    expect(metas.some(({ meta }) => meta.flattenedParents.size > 0)).toBe(true);
    expect(
      metas.some(({ meta }) => [...meta.leafByPhysical.values()].some((f) => f.storage === "json")),
    ).toBe(true);
    expect(metas.some(({ meta }) => meta.booleanFields.size > 0)).toBe(true);
    expect(
      metas.some(({ meta }) =>
        [...meta.flattenedParents].some((p) => meta.flatMap.get(p)?.optional),
      ),
    ).toBe(true);
  });

  it("produces identical rows (values and key order) for fuzzed physical rows", () => {
    const mapper = new RelationalFieldMapper();
    const r = rng(20261009);
    for (const { name, meta } of metas) {
      for (let n = 0; n < 300; n++) {
        const row = fuzzRow(meta, r);
        const expected = legacyReconstruct({ ...row }, meta);
        const actual = mapper.reconstructFromRead({ ...row }, meta);
        if (!sameShape(actual, expected)) {
          throw new Error(
            `${name}: mismatch for ${JSON.stringify(row)}\n` +
              `expected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`,
          );
        }
      }
    }
  });

  it("applies fromStorage formatters before coercion and only to non-null values", () => {
    const mapper = new RelationalFieldMapper();
    const r = rng(7);
    for (const { name, meta } of metas) {
      // A metadata twin with a formatter on every column (what adapters with
      // fromStorage formatters — dates, geo — install at build time).
      const twin = Object.create(meta) as TableMetadata;
      const fmts = new Map<string, (v: unknown) => unknown>();
      for (const physical of meta.leafByPhysical.keys()) {
        fmts.set(physical, (v) => (typeof v === "number" ? v + 1 : v));
      }
      (twin as { fromStorageFormatters?: unknown }).fromStorageFormatters = fmts;
      for (let n = 0; n < 100; n++) {
        const row = fuzzRow(meta, r);
        const expected = legacyReconstruct({ ...row }, twin);
        const actual = mapper.reconstructFromRead({ ...row }, twin);
        expect(sameShape(actual, expected), name).toBe(true);
      }
    }
  });

  it("gives every collapsed non-optional parent its own fresh object", () => {
    const mapper = new RelationalFieldMapper();
    const target = metas.find(({ meta }) =>
      [...meta.flattenedParents].some((p) => !meta.flatMap.get(p)?.optional),
    )!;
    const allNull = Object.fromEntries(
      [...target.meta.leafByPhysical.keys()].map((k) => [k, null]),
    );
    const a = mapper.reconstructFromRead({ ...allNull }, target.meta);
    const b = mapper.reconstructFromRead({ ...allNull }, target.meta);
    const parent = [...target.meta.flattenedParents].find(
      (p) => !target.meta.flatMap.get(p)?.optional && !p.includes("."),
    );
    if (parent) {
      expect(a[parent]).toEqual({});
      expect(a[parent]).not.toBe(b[parent]);
    }
  });
});

/** The pre-0.1.151 `writeFlattenedField` (recursive, per-key path concatenation). */
function legacyWriteField(
  path: string,
  value: unknown,
  result: Record<string, unknown>,
  meta: TableMetadata,
): void {
  if (meta.ignoredFields.has(path)) return;
  if (meta.flattenedParents.has(path)) {
    if (value === null || value === undefined) {
      for (const physical of meta.childrenByParent.get(path) ?? []) result[physical] = null;
    } else if (typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj))
        legacyWriteField(`${path}.${key}`, obj[key], result, meta);
    }
  } else {
    const fd = meta.leafByLogical.get(path);
    const physical = fd?.physicalName ?? path.replace(/\./g, "__");
    result[physical] =
      fd?.storage === "json" && value !== undefined && value !== null
        ? JSON.stringify(value)
        : value;
  }
}

/** The pre-0.1.151 full-flatten branch of prepareForWrite. */
function legacyPrepare(
  mapper: RelationalFieldMapper,
  payload: Record<string, unknown>,
  meta: TableMetadata,
  adapter: unknown,
) {
  const m = mapper as unknown as {
    prepareCommon: (d: Record<string, unknown>, m: TableMetadata, a: unknown) => void;
    formatWriteValues: (d: Record<string, unknown>, m: TableMetadata) => Record<string, unknown>;
  };
  const data = { ...payload };
  m.prepareCommon(data, meta, adapter);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(data)) legacyWriteField(key, data[key], result, meta);
  // Since 0.1.155: a nested column below an absent / null parent, or one only
  // some union members declare, is written as NULL when left out.
  for (const [physical, fd] of meta.leafByPhysical) {
    if (physical in result || fd.derived || fd.isPrimaryKey) continue;
    if (fd.storage === "column" || !fd.path.includes(".")) continue;
    const segs = fd.path.split(".");
    let parent: unknown = data;
    for (const seg of segs.slice(0, -1)) {
      parent =
        parent && typeof parent === "object" ? (parent as Record<string, unknown>)[seg] : null;
    }
    if (!parent || typeof parent !== "object" || meta.presence(fd.path) === "partial") {
      result[physical] = null;
    }
  }
  return m.formatWriteValues(result, meta);
}

/** A logical payload over the table's flatMap: random omissions, nulls, nested objects. */
function fuzzPayload(meta: TableMetadata, r: () => number): Record<string, unknown> {
  const build = (prefix: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [path, type] of meta.flatMap) {
      if (!path || meta.navFields.has(path)) continue;
      const parent = path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : "";
      if (parent !== prefix) continue;
      const key = path.slice(prefix ? prefix.length + 1 : 0);
      const roll = r();
      if (roll < 0.15) continue;
      if (roll < 0.25) {
        out[key] = null;
        continue;
      }
      const kind = (type as { type: { kind: string } }).type.kind;
      if (meta.flattenedParents.has(path)) out[key] = build(path);
      else if (kind === "array") out[key] = [1, "x"];
      else if (kind === "object") out[key] = { a: 1 };
      else out[key] = r() < 0.5 ? Math.floor(r() * 100) : `s${Math.floor(r() * 100)}`;
    }
    return out;
  };
  const payload = build("");
  if (r() < 0.2) payload.__unknown = 1;
  // Keys the schema does not know, nested under a flattened parent too.
  const parent = [...meta.flattenedParents].find((p) => !p.includes("."));
  if (parent && r() < 0.3 && payload[parent] && typeof payload[parent] === "object") {
    (payload[parent] as Record<string, unknown>)[`extra${Math.floor(r() * 3)}`] = { z: 1 };
  }
  return payload;
}

describe("relational write flatten — equivalence with copy + prepareCommon + flatten", () => {
  it("produces identical physical rows and leaves the payload untouched", () => {
    const mapper = new RelationalFieldMapper();
    const adapter = { prepareId: (v: unknown) => `id:${String(v)}` };
    const r = rng(99);
    for (const { name, meta } of metas) {
      for (let n = 0; n < 300; n++) {
        const payload = fuzzPayload(meta, r);
        const snapshot = JSON.stringify(payload);
        const expected = legacyPrepare(mapper, payload, meta, adapter);
        const actual = mapper.prepareForWrite(payload, meta, adapter as never);
        expect(JSON.stringify(payload), name).toBe(snapshot);
        if (!sameShape(actual, expected)) {
          throw new Error(
            `${name}: mismatch for ${snapshot}\n` +
              `expected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`,
          );
        }
      }
    }
  });
});
