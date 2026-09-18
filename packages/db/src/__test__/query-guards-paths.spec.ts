import { randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll } from "vite-plus/test";

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
    expect([...meta.jsonParents].toSorted()).toEqual(["ctx", "geo", "items", "tags"]);
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
      $having: { total: { $gt: 1 }, "count_*": { $gt: 0 } },
      $sort: { total: -1, "count_*": 1 },
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
      $having: { "contact.email": "a@b", "count_*": { $gt: 0 } },
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
