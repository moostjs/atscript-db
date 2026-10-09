import { DbError, type BaseDbAdapter, type DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { cloneValue } from "../memory-clone";
import { sortRows, projectRow, buildMemoryPredicate } from "../index";
import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

/**
 * Behaviour-equivalence of the 0.1.151 fast paths (PK lookup, unique-index
 * hash, plain-data clone, `$in` sets, compiled paths, top-k sort) against
 * reference copies of the previous scan-based semantics.
 */

type TRow = Record<string, unknown>;

/** Small deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

// ── reference semantics (the pre-0.1.151 implementations) ───────────────────

function refValuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}
function refMatchesScalar(fv: unknown, v: unknown): boolean {
  if (v === null) return fv == null || (Array.isArray(fv) && fv.includes(null));
  if (Array.isArray(fv) && !Array.isArray(v)) return fv.some((el) => refValuesEqual(el, v));
  return refValuesEqual(fv, v);
}
function refIn(fv: unknown, value: unknown): boolean {
  return Array.isArray(value) && value.some((el) => refMatchesScalar(fv, el));
}
function refGetPath(row: TRow, path: string): unknown {
  let c: unknown = row;
  for (const seg of path.split(".")) {
    if (c === null || typeof c !== "object" || Array.isArray(c)) return undefined;
    c = (c as TRow)[seg];
  }
  return c;
}
function refCompareLeaves(a: unknown, b: unknown): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return -1;
  if (bn) return 1;
  const av = (a instanceof Date ? a.getTime() : a) as number;
  const bv = (b instanceof Date ? b.getTime() : b) as number;
  return av < bv ? -1 : av > bv ? 1 : 0;
}
function refSort(rows: TRow[], $sort: Record<string, 1 | -1>, tie?: (r: TRow) => string): TRow[] {
  const keys = Object.entries($sort);
  return rows
    .map((row, index) => ({ row, index, tie: tie?.(row) }))
    .toSorted((a, b) => {
      for (const [f, d] of keys) {
        const c = refCompareLeaves(refGetPath(a.row, f), refGetPath(b.row, f));
        if (c !== 0) return d === -1 ? -c : c;
      }
      if (tie) return a.tie! < b.tie! ? -1 : a.tie! > b.tie! ? 1 : 0;
      return a.index - b.index;
    })
    .map((d) => d.row);
}

// ── cloneValue ───────────────────────────────────────────────────────────────

describe("cloneValue ≡ structuredClone", () => {
  const cases: Record<string, () => unknown> = {
    primitives: () => ({ s: "x", n: -0, nan: Number.NaN, b: true, big: 5n, u: undefined, z: null }),
    nested: () => ({ a: { b: { c: [1, { d: "e" }, [2, 3]] } }, t: ["x", "y"] }),
    dates: () => ({ at: new Date(5), bad: new Date(Number.NaN), list: [new Date(7)] }),
    nullProto: () => Object.assign(Object.create(null) as TRow, { a: 1, b: { c: 2 } }),
    ownProto: () => JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as unknown,
    sparse: () => ({ arr: [1, , 3] }), // oxlint-disable-line no-sparse-arrays
    arrayProps: () => {
      const arr: unknown[] & { extra?: number } = [1, 2];
      arr.extra = 3;
      return { arr };
    },
    shared: () => {
      const inner = { x: 1 };
      return { a: inner, b: inner };
    },
    cycle: () => {
      const o: TRow = { a: 1 };
      o.self = o;
      return o;
    },
    exotic: () => ({
      map: new Map([["k", 1]]),
      set: new Set([1]),
      re: /a/gi,
      typed: new Uint8Array([1, 2]),
      boxed: new String("s"), // oxlint-disable-line no-new-wrappers
    }),
    classInstance: () => {
      class Point {
        x = 1;
        y = 2;
      }
      return { p: new Point() };
    },
  };

  for (const [name, make] of Object.entries(cases)) {
    it(`matches structuredClone for ${name}`, () => {
      const value = make();
      const fast = cloneValue(value);
      const ref = structuredClone(value);
      expect(fast).toStrictEqual(ref);
      expect(fast).not.toBe(value);
    });
  }

  it("keeps an own __proto__ key as data (never re-prototypes the clone)", () => {
    const out = cloneValue(JSON.parse('{"__proto__": {"polluted": true}}') as TRow);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect((out as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("keeps holes, shared subtrees and cycles as structuredClone does", () => {
    const sparse = cloneValue({ arr: [1, , 3] }); // oxlint-disable-line no-sparse-arrays
    expect(1 in sparse.arr).toBe(false);
    const inner = { x: 1 };
    const shared = cloneValue({ a: inner, b: inner });
    expect(shared.a).toBe(shared.b);
    expect(shared.a).not.toBe(inner);
    const o: TRow = { a: 1 };
    o.self = o;
    const c = cloneValue(o);
    expect(c.self).toBe(c);
  });

  it("returns Dates and typed arrays as new instances of their class", () => {
    const out = cloneValue({ at: new Date(5), typed: new Uint8Array([1]) });
    expect(out.at).toBeInstanceOf(Date);
    expect(out.at.getTime()).toBe(5);
    expect(out.typed).toBeInstanceOf(Uint8Array);
  });

  it("throws DataCloneError on functions and symbols, like structuredClone", () => {
    const fnName = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as Error).name;
      }
      return "no error";
    };
    for (const value of [{ f: () => 1 }, { s: Symbol("x") }, [() => 1], () => 1]) {
      expect(fnName(() => cloneValue(value))).toBe("DataCloneError");
      expect(fnName(() => structuredClone(value))).toBe("DataCloneError");
    }
  });
});

// ── $in / $nin ───────────────────────────────────────────────────────────────

describe("$in / $nin set lookup ≡ element scan", () => {
  const shared = ["shared"];
  const obj = { o: 1 };
  const pool: unknown[] = [
    "a",
    "1",
    1,
    0,
    -0,
    Number.NaN,
    true,
    false,
    null,
    undefined,
    5n,
    new Date(5),
    new Date(5),
    new Date(Number.NaN),
    shared,
    obj,
    { o: 1 },
  ];
  const fieldPool: unknown[] = [
    ...pool,
    ["a", 1],
    [null],
    [new Date(5)],
    [Number.NaN],
    [undefined],
    [shared],
    [obj],
    [],
  ];

  it("agrees on every field value × random $in array", () => {
    const r = rng(42);
    for (let round = 0; round < 400; round++) {
      const list = Array.from({ length: Math.floor(r() * 6) }, () => pick(r, pool));
      if (r() < 0.2) list.push(shared);
      const isIn = buildMemoryPredicate({ f: { $in: list } } as never);
      const notIn = buildMemoryPredicate({ f: { $nin: list } } as never);
      for (const fv of fieldPool) {
        const row = fv === undefined && r() < 0.5 ? {} : { f: fv };
        expect(isIn(row)).toBe(refIn(fv, list));
        expect(notIn(row)).toBe(!refIn(fv, list));
      }
    }
  });

  it("a non-array $in matches nothing", () => {
    expect(buildMemoryPredicate({ f: { $in: "a" } } as never)({ f: "a" })).toBe(false);
  });
});

// ── sortRows (keys read once, top-k) ─────────────────────────────────────────

describe("sortRows ≡ the full comparator sort", () => {
  it("agrees with the reference sort and its head for every topK", () => {
    const r = rng(7);
    // Mixed kinds (full-sort fallback) and single-kind keys (one-pass head).
    const mixed = [1, 2, 2, 3, "a", "b", null, undefined, new Date(1), new Date(3)];
    const numeric = [1, 2, 2, 3, null, undefined, new Date(1), new Date(3), -0, 0];
    for (let round = 0; round < 120; round++) {
      const values = round % 2 ? mixed : numeric;
      const n = 1 + Math.floor(r() * 300);
      const rows: TRow[] = Array.from({ length: n }, (_, i) => ({
        id: `k${Math.floor(r() * n * 2)}-${i % 3}`,
        a: pick(r, values),
        nested: { b: pick(r, [1, 2, 3, undefined]) },
      }));
      const $sort: Record<string, 1 | -1> = r() < 0.5 ? { a: 1 } : { "nested.b": -1, a: 1 };
      // Duplicate tie keys on purpose (provider rows may repeat a key).
      const tie = r() < 0.5 ? (row: TRow) => String(row.id).slice(0, 2) : undefined;
      const expected = refSort(rows, $sort, tie);
      expect(sortRows(rows, $sort, tie)).toEqual(expected);
      for (const k of [0, 1, 2, 5, 20, 100, n]) {
        const head = sortRows(rows, $sort, tie, k);
        expect(head.slice(0, k)).toEqual(expected.slice(0, k));
        // Identity, not just equality: the same row objects in the same order.
        head.slice(0, k).forEach((row, i) => expect(row).toBe(expected[i]));
      }
    }
  });
});

// ── projection ───────────────────────────────────────────────────────────────

describe("projectRow (compiled) ≡ per-row projection", () => {
  const row = { id: 1, a: { b: 2, c: [1, 2] }, d: null, at: new Date(3) };
  it("inclusion / exclusion / none, cloned and not", () => {
    expect(projectRow(row, { "a.b": 1, d: 1, missing: 1 }, { clone: true })).toEqual({
      a: { b: 2 },
      d: null,
    });
    expect(projectRow(row, { a: 1 }, { pkFields: ["id"] })).toEqual({ a: row.a, id: 1 });
    expect(projectRow(row, { a: 1 }).a).toBe(row.a);
    const cloned = projectRow(row, { a: 1 }, { clone: true });
    expect(cloned.a).toEqual(row.a);
    expect(cloned.a).not.toBe(row.a);
    expect(projectRow(row, { "a.c": 0, at: 0 })).toEqual({ id: 1, a: { b: 2 }, d: null });
    expect(row.a.c).toEqual([1, 2]);
    expect(projectRow(row)).toBe(row);
    expect(projectRow(row, {}, { clone: true })).toStrictEqual(structuredClone(row));
  });
});

// ── adapter: PK fast path + unique-index hash, differential vs a scan model ──

let fx: Record<string, any>;
beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/insert-ignore.as");
});

describe("MemoryAdapter writes/reads ≡ the scan-based model", () => {
  let space: DbSpace;
  let adapter: BaseDbAdapter;
  beforeEach(async () => {
    space = createTestSpace();
    await bootstrapStoredTables(space, [fx.IgItem]);
    adapter = space.getAdapter(fx.IgItem);
  });

  const uniquePool: unknown[] = [
    "a",
    "b",
    "1",
    1,
    0,
    -0,
    Number.NaN,
    null,
    undefined,
    true,
    5n,
    new Date(5),
    new Date(Number.NaN),
    ["x"],
    { o: 1 },
  ];
  // IgItem: `sku_idx` (required sku) and `pair_idx` (optional pairA + pairB).
  const indexes = [
    { name: "sku_idx", fields: ["sku"], optional: [false] },
    { name: "pair_idx", fields: ["pairA", "pairB"], optional: [true, true] },
  ];

  function refConflict(
    rows: Map<string, TRow>,
    row: TRow,
    excludeKey?: string,
  ): string | undefined {
    for (const index of indexes) {
      const tuple: unknown[] = [];
      let skip = false;
      index.fields.forEach((f, i) => {
        const v = row[f];
        if (index.optional[i] && (v === null || v === undefined)) skip = true;
        tuple.push(v);
      });
      if (skip) continue;
      for (const [k, existing] of rows) {
        if (k === excludeKey) continue;
        if (index.fields.every((f, i) => refValuesEqual(existing[f], tuple[i]))) {
          return `Duplicate value for unique index "${index.name}"`;
        }
      }
    }
    return undefined;
  }

  const outcome = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await fn();
      return undefined;
    } catch (error) {
      if (error instanceof DbError) return error.errors[0]?.message;
      throw error;
    }
  };

  it("random insert / update / re-key / replace / delete sequences agree", async () => {
    const r = rng(1234);
    const model = new Map<string, TRow>();
    const key = (id: unknown) => JSON.stringify([id]);
    const randomRow = (id: number): TRow => {
      const row: TRow = { id, qty: Math.floor(r() * 10) };
      for (const f of ["sku", "pairA", "pairB"]) {
        const v = pick(r, uniquePool);
        if (v !== undefined || r() < 0.5) row[f] = v;
      }
      return row;
    };
    for (let step = 0; step < 1500; step++) {
      const id = Math.floor(r() * 40);
      const op = pick(r, ["insert", "insert", "update", "rekey", "replace", "delete"]);
      if (op === "insert") {
        const row = randomRow(id);
        const expected = model.has(key(id)) ? "Duplicate primary key" : refConflict(model, row);
        expect(await outcome(() => adapter.insertOne(row))).toBe(expected);
        if (!expected) model.set(key(id), structuredClone(row));
      } else if (op === "update" || op === "rekey") {
        const old = model.get(key(id));
        const field = pick(r, ["sku", "pairA", "pairB"]);
        const patch: TRow =
          op === "rekey" ? { id: Math.floor(r() * 40) } : { [field]: pick(r, uniquePool) };
        let expected: string | undefined;
        if (old) {
          const next = { ...structuredClone(old), ...structuredClone(patch) };
          expected = refConflict(model, next, key(id));
          if (!expected && key(next.id) !== key(id) && model.has(key(next.id))) {
            expected = "Duplicate primary key";
          }
          if (!expected) {
            if (key(next.id) === key(id)) model.set(key(id), next);
            else {
              model.delete(key(id));
              model.set(key(next.id), next);
            }
          }
        }
        expect(await outcome(() => adapter.updateOne({ id }, patch))).toBe(expected);
      } else if (op === "replace") {
        const old = model.get(key(id));
        const next = randomRow(id);
        let expected: string | undefined;
        if (old) {
          expected = refConflict(model, next, key(id));
          if (!expected) model.set(key(id), structuredClone(next));
        }
        expect(await outcome(() => adapter.replaceOne({ id }, next))).toBe(expected);
      } else {
        model.delete(key(id));
        await adapter.deleteOne({ id: { $eq: id } });
      }
    }
    // Store order (insertion order, updates keep their position) and content.
    expect(await adapter.findMany({ filter: {}, controls: {} } as never)).toEqual([
      ...model.values(),
    ]);
    for (let id = 0; id < 40; id++) {
      expect(await adapter.findOne({ filter: { id }, controls: {} } as never)).toEqual(
        model.get(key(id)) ?? null,
      );
    }
  });

  it("re-records existing rows on syncIndexes (duplicates already stored keep conflicting)", async () => {
    space = createTestSpace();
    adapter = space.getAdapter(fx.IgItem);
    await adapter.ensureTable();
    await adapter.insertMany([
      { id: 1, sku: "a", qty: 1 },
      { id: 2, sku: "a", qty: 1 },
    ]);
    await adapter.syncIndexes();
    // Row 1 changing its own sku still collides with row 2's "a" — and back.
    expect(await outcome(() => adapter.updateOne({ id: 1 }, { qty: 2 }))).toBe(
      'Duplicate value for unique index "sku_idx"',
    );
    await adapter.deleteOne({ id: 2 });
    expect(await outcome(() => adapter.updateOne({ id: 1 }, { qty: 2 }))).toBeUndefined();
    expect(await outcome(() => adapter.insertOne({ id: 3, sku: "a", qty: 1 }))).toBe(
      'Duplicate value for unique index "sku_idx"',
    );
  });

  it("resolves a pinned primary key by lookup but still applies the rest of the filter", async () => {
    await adapter.insertMany([
      { id: 1, sku: "a", qty: 1 },
      { id: 2, sku: "b", qty: 2 },
    ]);
    const find = (filter: unknown) => adapter.findMany({ filter, controls: {} } as never);
    expect(await find({ id: 2 })).toEqual([{ id: 2, sku: "b", qty: 2 }]);
    expect(await find({ id: { $eq: 2 }, qty: 2 })).toHaveLength(1);
    expect(await find({ $and: [{ qty: { $gte: 0 } }, { $and: [{ id: 2 }] }] })).toHaveLength(1);
    expect(await find({ id: 2, qty: 1 })).toEqual([]);
    expect(await find({ $and: [{ id: 1 }, { id: 2 }] })).toEqual([]);
    expect(await find({ id: "2" })).toEqual([]);
    expect(await find({ id: 3 })).toEqual([]);
    expect(await adapter.count({ filter: { id: 1 }, controls: {} } as never)).toBe(1);
    expect((await adapter.updateOne({ id: 1, qty: 9 }, { qty: 5 })).matchedCount).toBe(0);
    expect((await adapter.updateOne({ id: 1, qty: 1 }, { qty: 5 })).matchedCount).toBe(1);
  });

  it("falls back to the scan once a stored primary key is not a scalar", async () => {
    await adapter.insertOne({ id: [1, 2], sku: "a", qty: 1 });
    // Containment: `{ id: 1 }` matches the array key, which no lookup key encodes.
    expect(await adapter.findOne({ filter: { id: 1 }, controls: {} } as never)).toMatchObject({
      id: [1, 2],
    });
    expect((await adapter.deleteOne({ id: 2 })).deletedCount).toBe(1);
  });

  it("findOne without $sort stops at the $skip-th match; with $sort picks the same row as a full sort", async () => {
    await adapter.insertMany(
      Array.from({ length: 50 }, (_, i) => ({ id: i, sku: `s${i}`, qty: i % 4 })),
    );
    const one = (controls: TRow) =>
      adapter.findOne({ filter: { qty: 1 }, controls } as never) as Promise<TRow | null>;
    expect((await one({}))!.id).toBe(1);
    expect((await one({ $skip: 2 }))!.id).toBe(9);
    expect(await one({ $skip: 50 })).toBeNull();
    expect((await one({ $sort: { id: -1 }, $skip: 1 }))!.id).toBe(45);
    const page = (await adapter.findManyWithCount({
      filter: {},
      controls: { $sort: { qty: -1 }, $skip: 3, $limit: 4 },
    } as never)) as { data: TRow[]; count: number };
    const full = (await adapter.findMany({
      filter: {},
      controls: { $sort: { qty: -1 } },
    } as never)) as TRow[];
    expect(page.count).toBe(50);
    expect(page.data).toEqual(full.slice(3, 7));
  });
});
