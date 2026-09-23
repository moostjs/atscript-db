import { randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll } from "vite-plus/test";

import {
  acceptedOperatorsHint,
  canFilterLeaf,
  collectQueryPaths,
  filterPredicateOf,
  narrowerFilterOps,
} from "../query/query-guards";
import { DbSpace } from "../table/db-space";
import type { AtscriptDbTable } from "../table/db-table";
import { findAncestorInSet } from "../table/table-metadata";
import type { TDbFieldMeta } from "../types";
import type { DbQuery } from "../types";
import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

/**
 * Core path guard (`guardPaths`, since 0.1.128): every filter / `$sort` /
 * `$select` / `$groupBy` / `$having` / aggregate path must resolve to physical
 * storage on THIS adapter and pass the adapter's capability, or the query is
 * rejected with `INVALID_QUERY` before any translation — so no bogus column
 * name ever reaches a SQL builder. The same rules run on both adapter
 * families; only the descriptor set differs (relational adapters have no
 * descriptors for JSON descendants, nested-object adapters do).
 */

const KEYS = { k1: randomBytes(32) };

/** Relational-style adapter (the repo mock: flattening, JSON storage, base capability). */
class SqlLikeAdapter extends MockAdapter {
  override isGeoSearchable(): boolean {
    return true;
  }
  override async geoSearch(_point: [number, number], query: DbQuery) {
    this.calls.push({ method: "geoSearch", args: [query] });
    return [];
  }
}

/** Document-style adapter: nested objects kept inline, Mongo/memory filter capability. */
class NestedAdapter extends NestedMockAdapter {
  override canFilterField(fd: TDbFieldMeta): boolean {
    return !fd.encrypted;
  }
}

let GuardSource: any;
let GuardTarget: any;

function makeSpace(factory: () => MockAdapter) {
  return new DbSpace(factory, { encryption: { defaultKeyId: "k1", keys: KEYS } });
}

function sqlTable(): { table: AtscriptDbTable; adapter: SqlLikeAdapter } {
  const adapters: SqlLikeAdapter[] = [];
  const db = makeSpace(() => {
    const a = new SqlLikeAdapter();
    adapters.push(a);
    return a;
  });
  db.getTable(GuardTarget);
  const table = db.getTable(GuardSource);
  table.getMetadata();
  return { table, adapter: adapters[adapters.length - 1]! };
}

function nestedTable(): { table: AtscriptDbTable; adapter: NestedAdapter } {
  const adapters: NestedAdapter[] = [];
  const db = makeSpace(() => {
    const a = new NestedAdapter();
    adapters.push(a);
    return a;
  });
  db.getTable(GuardTarget);
  const table = db.getTable(GuardSource);
  table.getMetadata();
  return { table, adapter: adapters[adapters.length - 1]! };
}

const q = (filter: Record<string, unknown>, controls: Record<string, unknown> = {}) =>
  ({ filter, controls }) as any;

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; errors: Array<{ path: string; message: string }> };
  }
  throw new Error("expected rejection");
}

beforeAll(async () => {
  await prepareFixtures();
  ({ GuardSource, GuardTarget } = await import("./fixtures/guard-paths.as"));
});

describe("TableMetadata — guard indexes are built for every adapter", () => {
  it("relational: descriptorByPath = physical leaves; JSON descendants absent; jsonParents retained", () => {
    const { table } = sqlTable();
    const meta = table.getMetadata();
    expect([...meta.descriptorByPath.keys()]).toEqual(
      expect.arrayContaining([
        "id",
        "title",
        "rank",
        "contact.email",
        "ctx",
        "tags",
        "items",
        "credentials",
        "geo",
        "targetId",
      ]),
    );
    expect(meta.descriptorByPath.has("ctx.sub")).toBe(false);
    expect(meta.descriptorByPath.has("items.sku")).toBe(false);
    expect(meta.descriptorByPath.has("credentials.user")).toBe(false);
    expect(meta.descriptorByPath.has("target")).toBe(false);
    expect(meta.descriptorByPath.has("target.name")).toBe(false);
    expect([...meta.jsonParents].toSorted()).toEqual(["ctx", "geo", "items", "tags", "wrap.blob"]);
    expect(findAncestorInSet("credentials.user", meta.encryptedFields)).toBe("credentials");
    expect(findAncestorInSet("credentials", meta.encryptedFields)).toBeUndefined();
  });

  it("nested-object: JSON descendants are descriptors, nav descendants are not, jsonParents is empty", () => {
    const { table } = nestedTable();
    const meta = table.getMetadata();
    expect(meta.leafByLogical.size).toBe(0);
    expect(meta.descriptorByPath.has("ctx.sub")).toBe(true);
    expect(meta.descriptorByPath.has("ctx.deep.leaf")).toBe(true);
    expect(meta.descriptorByPath.has("items.sku")).toBe(true);
    expect(meta.descriptorByPath.has("contact")).toBe(true);
    expect(meta.descriptorByPath.has("target")).toBe(false);
    expect(meta.descriptorByPath.has("target.name")).toBe(false);
    expect(meta.jsonParents.size).toBe(0);
  });
});

describe("guardPaths — relational adapter", () => {
  it("rejects a JSON descendant in filter / $sort / $select before any adapter call", async () => {
    const { table, adapter } = sqlTable();
    for (const query of [
      q({ "ctx.sub": "x" }),
      q({}, { $sort: { "ctx.sub": 1 } }),
      q({}, { $select: ["id", "ctx.sub"] }),
      q({}, { $select: { "ctx.deep.leaf": 1 } }),
      q({ "items.sku": "a" }),
    ]) {
      const err = await rejection(table.findMany(query));
      expect(err.code).toBe("INVALID_QUERY");
      expect(err.errors[0]!.message).toMatch(/JSON-stored column "(ctx|items)"/);
    }
    expect(adapter.calls.filter((c) => c.method === "findMany")).toHaveLength(0);
  });

  it("rejects filter / $sort on the JSON parent itself (adapter capability) but allows $select of it", async () => {
    const { table, adapter } = sqlTable();
    const f = await rejection(table.findMany(q({ ctx: "x" })));
    expect(f.errors[0]).toMatchObject({
      path: "ctx",
      message: expect.stringContaining("cannot filter"),
    });
    const s = await rejection(table.findMany(q({}, { $sort: { tags: 1 } })));
    expect(s.errors[0]).toMatchObject({
      path: "tags",
      message: expect.stringContaining("cannot sort"),
    });
    await table.findMany(q({}, { $select: ["id", "ctx", "tags"] }));
    expect(adapter.calls.filter((c) => c.method === "findMany")).toHaveLength(1);
  });

  it("flattened object parent: $select expands, filter / $sort are rejected as nested objects", async () => {
    const { table, adapter } = sqlTable();
    await table.findMany(q({}, { $select: ["contact"] }));
    expect(adapter.calls.filter((c) => c.method === "findMany")).toHaveLength(1);
    const f = await rejection(table.findMany(q({ contact: "x" })));
    expect(f.errors[0]).toMatchObject({
      path: "contact",
      message: expect.stringContaining("nested object"),
    });
    const s = await rejection(table.findMany(q({}, { $sort: { contact: 1 } })));
    expect(s.errors[0]!.message).toContain("nested object");
    // Leaves stay fine.
    await table.findMany(q({ "contact.email": "a@b" }, { $sort: { "contact.email": 1 } }));
  });

  it("navigation paths are rejected first on every op, with a $with hint", async () => {
    const { table } = sqlTable();
    for (const query of [
      q({ "target.name": "x" }),
      q({}, { $sort: { "target.name": 1 } }),
      q({}, { $select: ["target.name"] }),
      q({}, { $select: ["target"] }),
      q({ target: 1 }),
    ]) {
      const err = await rejection(table.findMany(query));
      expect(err.code).toBe("INVALID_QUERY");
      expect(err.errors[0]!.message).toMatch(/navigation path/);
    }
  });

  it("encrypted subtree: ENC_FIELD_* codes still fire first for filter / sort; $select of a descendant names the parent", async () => {
    const { table } = sqlTable();
    expect((await rejection(table.findMany(q({ "credentials.user": "x" })))).code).toBe(
      "ENC_FIELD_FILTER",
    );
    expect((await rejection(table.findMany(q({ credentials: "x" })))).code).toBe(
      "ENC_FIELD_FILTER",
    );
    expect((await rejection(table.findMany(q({}, { $sort: { credentials: 1 } })))).code).toBe(
      "ENC_FIELD_SORT",
    );
    const sel = await rejection(table.findMany(q({}, { $select: ["credentials.user"] })));
    expect(sel.code).toBe("INVALID_QUERY");
    expect(sel.errors[0]!.message).toContain('select "credentials" instead');
    // The encrypted column itself is selectable (decrypted on read).
    await table.findMany(q({}, { $select: ["id", "credentials"] }));
  });

  it("unknown paths → Unknown field on every op (filter, $sort, $select array + map)", async () => {
    const { table } = sqlTable();
    for (const query of [
      q({ nope: 1 }),
      q({}, { $sort: { nope: 1 } }),
      q({}, { $select: ["nope"] }),
      q({}, { $select: { nope: 0 } }),
      q({ $and: [{ title: "a" }, { $or: [{ nope: 1 }] }] }),
    ]) {
      const err = await rejection(table.findMany(query));
      expect(err.errors[0]).toMatchObject({ path: "nope", message: 'Unknown field "nope"' });
    }
  });

  it("rejects filter-node $-keys uniqu does not treat as logical (e.g. $nor)", async () => {
    const { table } = sqlTable();
    const err = await rejection(table.findMany(q({ $nor: [{ title: "a" }] })));
    // One wording for the core guard and the HTTP gate (`unsupportedOperatorMessage`).
    expect(err.errors[0]).toEqual({
      path: "$nor",
      message: 'Unsupported filter operator "$nor" — use $and, $or or $not',
    });
  });

  it("a $geoWithin predicate on the geo field passes the path guard (shape/index validated by the geo guard)", async () => {
    const { table, adapter } = sqlTable();
    await table.findMany(q({ geo: { $geoWithin: { center: [0, 0], radius: 100 } } }));
    expect(adapter.calls.filter((c) => c.method === "findMany")).toHaveLength(1);
    // …but a plain equality on the same JSON-stored column is still vetoed.
    const err = await rejection(table.findMany(q({ geo: [0, 0] })));
    expect(err.errors[0]!.message).toContain("cannot filter");
  });

  it("aggregate: $groupBy / aggregate $field / $having keys are guarded; aliases are exempt in $sort and $having", async () => {
    const { table, adapter } = sqlTable();
    const agg = (controls: Record<string, unknown>) =>
      table.aggregate({ filter: {}, controls: { $groupBy: ["title"], ...controls } } as any);
    const g = await rejection(agg({ $groupBy: ["ctx.sub"] }));
    expect(g.errors[0]!.message).toContain("JSON-stored");
    const a = await rejection(
      agg({ $select: ["title", { $fn: "sum", $field: "ctx.sub", $as: "t" }] }),
    );
    expect(a.errors[0]!.message).toContain("JSON-stored");
    const h = await rejection(
      agg({
        $select: ["title", { $fn: "sum", $field: "rank", $as: "total" }],
        $having: { nope: { $gt: 1 } },
      }),
    );
    expect(h.errors[0]).toMatchObject({ path: "nope" });
    await agg({
      $select: [
        "title",
        { $fn: "sum", $field: "rank", $as: "total" },
        { $fn: "count", $field: "*" },
      ],
      $having: { total: { $gt: 1 }, count_star: { $gt: 0 } },
      $sort: { total: -1, count_star: 1 },
    });
    expect(adapter.calls.filter((c) => c.method === "aggregate")).toHaveLength(1);
  });

  it("aggregate: a $having key must be an aggregate alias or a $groupBy field (real columns are not enough)", async () => {
    const { table, adapter } = sqlTable();
    const total = { $fn: "sum", $field: "rank", $as: "total" };
    const agg = (controls: Record<string, unknown>) =>
      table.aggregate({
        filter: {},
        controls: { $groupBy: ["title"], $select: ["title", total], ...controls },
      } as any);
    const message = '$having key "rank" must be an aggregate alias or a $groupBy field';
    // `rank` is a real column — it exists, so the path guard passes; the rule rejects it.
    const flat = await rejection(agg({ $having: { rank: { $gt: 1 } } }));
    expect(flat.code).toBe("INVALID_QUERY");
    expect(flat.errors).toEqual([{ path: "rank", message }]);
    // Nested $and / $or / $not are walked; the offending key is still reported bare.
    const nested = await rejection(
      agg({
        $having: {
          $and: [{ total: { $gt: 1 } }, { $or: [{ title: "a" }, { $not: { rank: { $gt: 2 } } }] }],
        },
      }),
    );
    expect(nested.errors).toEqual([{ path: "rank", message }]);
    // An unknown key still reads `Unknown field` (existence is checked first).
    const unknown = await rejection(agg({ $having: { nope: 1 } }));
    expect(unknown.errors[0]!.message).toBe('Unknown field "nope"');
    expect(adapter.calls.filter((c) => c.method === "aggregate")).toHaveLength(0);
    // Aliases and grouped columns pass — a grouped flattened leaf matches on its logical path.
    await agg({ $having: { total: { $gt: 1 }, $or: [{ title: "a" }, { $not: { title: "b" } }] } });
    await agg({
      $groupBy: ["contact.email"],
      $select: ["contact.email", { $fn: "count", $field: "*" }],
      $having: { "contact.email": "a@b", count_star: { $gt: 0 } },
    });
    expect(adapter.calls.filter((c) => c.method === "aggregate")).toHaveLength(2);
  });

  it("updateMany / deleteMany filters go through the same guard (_guardMutationFilter)", async () => {
    const { table, adapter } = sqlTable();
    const u = await rejection(table.updateMany({ "ctx.sub": "x" } as any, { title: "y" } as any));
    expect(u.code).toBe("INVALID_QUERY");
    expect(u.errors[0]!.message).toContain("JSON-stored");
    const d = await rejection(table.deleteMany({ "target.name": "x" } as any));
    expect(d.errors[0]!.message).toContain("navigation path");
    const n = await rejection(table.deleteMany({ nope: 1 } as any));
    expect(n.errors[0]!.message).toBe('Unknown field "nope"');
    expect(
      adapter.calls.filter((c) => c.method === "updateMany" || c.method === "deleteMany"),
    ).toHaveLength(0);
    // Physical filters still reach the adapter.
    await table.deleteMany({ "contact.email": "a@b" } as any);
    expect(adapter.calls.filter((c) => c.method === "deleteMany")).toHaveLength(1);
  });
});

describe("guardPaths — nested-object adapter", () => {
  it("JSON descendants and array-of-object descendants are physical: filter / $sort / $select pass", async () => {
    const { table, adapter } = nestedTable();
    await table.findMany(
      q(
        { "ctx.sub": "x", "items.sku": "a" },
        { $sort: { "ctx.deep.leaf": 1 }, $select: ["id", "ctx.sub"] },
      ),
    );
    expect(adapter.calls.filter((c) => c.method === "findMany")).toHaveLength(1);
    await table.aggregate({
      filter: {},
      controls: { $groupBy: ["ctx.sub"], $select: ["ctx.sub", { $fn: "count", $field: "*" }] },
    } as any);
    expect(adapter.calls.filter((c) => c.method === "aggregate")).toHaveLength(1);
  });

  it("array / @db.json columns are filterable but never sortable (base canSortField designType veto)", async () => {
    const { table } = nestedTable();
    await table.findMany(q({ tags: "a", ctx: { $exists: true } }));
    const s1 = await rejection(table.findMany(q({}, { $sort: { tags: 1 } })));
    expect(s1.errors[0]).toMatchObject({
      path: "tags",
      message: expect.stringContaining("cannot sort"),
    });
    const s2 = await rejection(table.findMany(q({}, { $sort: { ctx: -1 } })));
    expect(s2.errors[0]).toMatchObject({ path: "ctx" });
  });

  it("navigation descendants are rejected even though the adapter keeps descriptors for them", async () => {
    const { table } = nestedTable();
    const err = await rejection(table.findMany(q({ "target.name": "x" })));
    expect(err.errors[0]!.message).toMatch(/navigation path/);
    const sel = await rejection(table.findMany(q({}, { $select: ["target.id"] })));
    expect(sel.errors[0]!.message).toMatch(/navigation path/);
  });

  it("encrypted and unknown paths behave as on relational adapters", async () => {
    const { table } = nestedTable();
    expect((await rejection(table.findMany(q({ "credentials.user": "x" })))).code).toBe(
      "ENC_FIELD_FILTER",
    );
    const n = await rejection(table.findMany(q({ nope: 1 })));
    expect(n.errors[0]!.message).toBe('Unknown field "nope"');
    // Encrypted descendants stay descriptors here → selectable (decrypted on read).
    await table.findMany(q({}, { $select: ["credentials.user"] }));
  });
});

// ── Existence-only predicates (since 0.1.132) ───────────────────────────────
//
// An entry whose ONLY operator is `$exists: <boolean>` tests whether the
// stored column holds a value (SQL `IS [NOT] NULL`), never its content, so it
// needs a stored, non-encrypted column — not the adapter's scalar
// `canFilterField`. Every other predicate on the same JSON column keeps the
// veto, judged per occurrence.

/** Adapter-shaped capability stubs for `canFilterLeaf` / `narrowerFilterOps`. */
const cap = (canFilter: boolean, geo: boolean) => ({
  canFilterField: () => canFilter,
  isGeoSearchable: () => geo,
});
const findCalls = (adapter: SqlLikeAdapter) =>
  adapter.calls.filter((c) => c.method === "findMany").length;

describe("filterPredicateOf / canFilterLeaf — the shared classification", () => {
  it("classifies an entry by the operator class it needs", () => {
    expect(filterPredicateOf({ $exists: true })).toBe("exists");
    expect(filterPredicateOf({ $exists: false })).toBe("exists");
    expect(filterPredicateOf(Object.assign(Object.create(null), { $exists: true }))).toBe("exists");
    // Anything beside $exists is a value comparison; operand validity is guardFilter's.
    expect(filterPredicateOf({ $exists: true, $eq: 1 })).toBe("compare");
    expect(filterPredicateOf({ $exists: true, $ne: null })).toBe("compare");
    expect(filterPredicateOf({ $exists: 1 })).toBe("exists");
    expect(filterPredicateOf({ $eq: 1 })).toBe("compare");
    expect(filterPredicateOf("x")).toBe("compare");
    expect(filterPredicateOf(null)).toBe("compare");
    expect(filterPredicateOf([1])).toBe("compare");
    expect(filterPredicateOf(new Date())).toBe("compare");
    expect(filterPredicateOf({ $geoWithin: { center: [0, 0], radius: 1 } })).toBe("geo");
  });

  it("existence needs a stored non-encrypted column; compare defers to the adapter; geo needs a geoPoint on a geo-searchable adapter", () => {
    const json = { storage: "json", designType: "json" } as unknown as TDbFieldMeta;
    const enc = { storage: "column", encrypted: true, isGeoPoint: true } as unknown as TDbFieldMeta;
    const geo = { storage: "json", isGeoPoint: true } as unknown as TDbFieldMeta;
    expect(canFilterLeaf(json, "exists", cap(false, false))).toBe(true);
    expect(canFilterLeaf(json, "compare", cap(false, true))).toBe(false);
    expect(canFilterLeaf(json, "compare", cap(true, false))).toBe(true);
    expect(canFilterLeaf(json, "geo", cap(true, true))).toBe(false);
    expect(canFilterLeaf(geo, "geo", cap(false, true))).toBe(true);
    expect(canFilterLeaf(geo, "geo", cap(true, false))).toBe(false);
    for (const predicate of ["compare", "exists", "geo"] as const) {
      expect(canFilterLeaf(enc, predicate, cap(true, true))).toBe(false);
    }
    expect(narrowerFilterOps(json, cap(false, true))).toEqual(["$exists"]);
    expect(narrowerFilterOps(geo, cap(false, true))).toEqual(["$exists", "$geoWithin"]);
    expect(narrowerFilterOps(geo, cap(false, false))).toEqual(["$exists"]);
    expect(narrowerFilterOps(enc, cap(true, true))).toEqual([]);
    expect(acceptedOperatorsHint(["$exists"])).toBe(" (accepted operators: $exists)");
    expect(acceptedOperatorsHint([])).toBe("");
  });

  it("collectQueryPaths records every filter entry per occurrence with its class", () => {
    const refs = collectQueryPaths({
      filter: {
        ctx: { $exists: true },
        $or: [{ ctx: "x" }, { $not: { geo: { $geoWithin: { center: [0, 0], radius: 1 } } } }],
        $and: [{ ctx: { $exists: false } }, { title: { $exists: true, $ne: "a" } }],
      } as any,
    });
    expect(refs.filter).toEqual([
      { path: "ctx", predicate: "exists" },
      { path: "ctx", predicate: "compare" },
      { path: "geo", predicate: "geo" },
      { path: "ctx", predicate: "exists" },
      { path: "title", predicate: "compare" },
    ]);
  });
});

describe("guardPaths — existence-only predicates on JSON-stored columns (relational)", () => {
  it("$exists true / false on a @db.json object, arrays, a nested JSON column and a geoPoint pass", async () => {
    const { table, adapter } = sqlTable();
    for (const filter of [
      { ctx: { $exists: true } },
      { ctx: { $exists: false } },
      { tags: { $exists: true } },
      { items: { $exists: false } },
      { "wrap.blob": { $exists: true } },
      { geo: { $exists: true } },
    ]) {
      await table.findMany(q(filter));
    }
    expect(findCalls(adapter)).toBe(6);
  });

  it("composes through $and / $or / $not and with scalar predicates", async () => {
    const { table, adapter } = sqlTable();
    await table.findMany(
      q({
        $or: [{ ctx: { $exists: true } }, { $not: { tags: { $exists: false } } }],
        $and: [{ title: "a" }, { "wrap.blob": { $exists: false } }],
      }),
    );
    await table.count(q({ $not: { ctx: { $exists: true } } }));
    expect(findCalls(adapter)).toBe(1);
  });

  it("each occurrence is judged on its own: an allowed $exists never exempts another entry on the same column", async () => {
    const { table, adapter } = sqlTable();
    for (const filter of [
      { $and: [{ ctx: { $exists: true } }, { ctx: "x" }] },
      { $or: [{ ctx: { $exists: true } }, { $not: { ctx: { $eq: 1 } } }] },
      { $and: [{ ctx: { $exists: false } }], ctx: { $ne: null } },
      { $or: [{ tags: { $exists: true } }, { tags: { $in: ["a"] } }] },
    ]) {
      const err = await rejection(table.findMany(q(filter)));
      expect(err.code).toBe("INVALID_QUERY");
      expect(err.errors[0]).toEqual({
        path: expect.stringMatching(/^(ctx|tags)$/),
        message: expect.stringContaining("(accepted operators: $exists)"),
      });
    }
    expect(findCalls(adapter)).toBe(0);
  });

  it("mixed operators on one entry are a value comparison → rejected", async () => {
    const { table } = sqlTable();
    for (const value of [{ $exists: true, $eq: 1 }, { $exists: true, $ne: null }, { $eq: null }]) {
      const err = await rejection(table.findMany(q({ ctx: value })));
      expect(err.errors[0]).toEqual({
        path: "ctx",
        message:
          'Cannot filter on "ctx" — adapter cannot filter on this storage type (accepted operators: $exists)',
      });
    }
  });

  it("descendants, nested-object parents and navigation paths stay rejected for $exists", async () => {
    const { table } = sqlTable();
    const desc = await rejection(table.findMany(q({ "ctx.sub": { $exists: true } })));
    expect(desc.errors[0]).toMatchObject({
      path: "ctx.sub",
      message: expect.stringContaining('JSON-stored column "ctx"'),
    });
    const blob = await rejection(table.findMany(q({ "wrap.blob.v": { $exists: true } })));
    expect(blob.errors[0]!.message).toContain('JSON-stored column "wrap.blob"');
    const parent = await rejection(table.findMany(q({ contact: { $exists: true } })));
    expect(parent.errors[0]!.message).toContain("nested object");
    const nav = await rejection(table.findMany(q({ target: { $exists: false } })));
    expect(nav.errors[0]!.message).toContain("navigation path");
  });

  it("a non-boolean $exists operand is INVALID_QUERY on any field (JSON or scalar)", async () => {
    const { table, adapter } = sqlTable();
    for (const [path, operand] of [
      ["ctx", 1],
      ["ctx", "true"],
      ["title", 0],
      ["title", null],
    ] as const) {
      const err = await rejection(table.findMany(q({ [path]: { $exists: operand } })));
      expect(err.code).toBe("INVALID_QUERY");
      expect(err.errors).toEqual([{ path, message: `$exists on "${path}" expects true or false` }]);
    }
    const nested = await rejection(table.findMany(q({ $or: [{ title: { $exists: "no" } }] })));
    expect(nested.errors[0]!.path).toBe("title");
    expect(findCalls(adapter)).toBe(0);
  });

  it("$exists on an @db.encrypted field is still ENC_FIELD_FILTER (encryption guard runs first)", async () => {
    const { table } = sqlTable();
    expect((await rejection(table.findMany(q({ credentials: { $exists: true } })))).code).toBe(
      "ENC_FIELD_FILTER",
    );
    expect((await rejection(table.findMany(q({ credentials: { $exists: "x" } })))).code).toBe(
      "ENC_FIELD_FILTER",
    );
  });

  it("$sort / $groupBy / $having / aggregate positions on a JSON column are unchanged", async () => {
    const { table, adapter } = sqlTable();
    const s = await rejection(table.findMany(q({ ctx: { $exists: true } }, { $sort: { ctx: 1 } })));
    expect(s.errors[0]).toMatchObject({
      path: "ctx",
      message: expect.stringContaining("cannot sort"),
    });
    const agg = (controls: Record<string, unknown>, filter: Record<string, unknown> = {}) =>
      table.aggregate({ filter, controls } as any);
    const g = await rejection(
      agg({ $groupBy: ["ctx"], $select: ["ctx", { $fn: "count", $field: "*" }] }),
    );
    expect(g.errors[0]).toMatchObject({
      path: "ctx",
      message: expect.stringContaining("group by"),
    });
    const h = await rejection(
      agg({
        $groupBy: ["title"],
        $select: ["title", { $fn: "count", $field: "*" }],
        $having: { ctx: { $exists: true } },
      }),
    );
    expect(h.errors[0]).toMatchObject({ path: "ctx", message: expect.stringContaining("$having") });
    const a = await rejection(
      agg({ $groupBy: ["title"], $select: ["title", { $fn: "count", $field: "ctx" }] }),
    );
    expect(a.errors[0]).toMatchObject({ path: "ctx" });
    // The aggregate FILTER is a filter: existence passes there.
    await agg(
      { $groupBy: ["title"], $select: ["title", { $fn: "count", $field: "*" }] },
      { ctx: { $exists: true } },
    );
    expect(adapter.calls.filter((c) => c.method === "aggregate")).toHaveLength(1);
  });

  it("updateMany / deleteMany filters accept existence on a JSON column too", async () => {
    const { table, adapter } = sqlTable();
    await table.updateMany({ ctx: { $exists: false } } as any, { title: "y" } as any);
    await table.deleteMany({ tags: { $exists: true } } as any);
    const err = await rejection(table.deleteMany({ tags: "a" } as any));
    expect(err.errors[0]!.message).toContain("(accepted operators: $exists)");
    expect(
      adapter.calls.filter((c) => c.method === "updateMany" || c.method === "deleteMany"),
    ).toHaveLength(2);
  });
});
