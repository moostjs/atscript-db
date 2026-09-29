import { describe, it, expect, beforeAll, beforeEach, vi } from "vite-plus/test";
import type { FilterExpr } from "@uniqu/core";

import { BaseDbAdapter } from "../base-adapter";
import { DbError } from "../db-error";
import { DbSpace } from "../table/db-space";
import type {
  DbQuery,
  TDbDeleteResult,
  TDbInsertManyResult,
  TDbInsertResult,
  TDbUpdateResult,
  TDbWriteCheckContext,
} from "../types";
import { matchesFilter, prepareFixtures } from "./test-utils";

/**
 * Write-path integrity (since 0.1.143):
 * - ids address exactly ONE row, primary key first (writes, pre-images, findById);
 * - nested writes only touch rows related to the record being written;
 * - nested phases are skipped for rows the main write did not match;
 * - the post-write `check` hook.
 */

let WiSlug: any;
let WiUser: any;
let WiTag: any;
let WiProject: any;
let WiNote: any;
let WiProjectTag: any;
let WiCounter: any;

type Row = Record<string, unknown>;
type Store = Map<string, Row[]>;

/** Read log + an optional hook run after every read (to simulate concurrent writers). */
interface ReadTrace {
  reads: string[];
  afterRead?: (table: string) => void;
}

/** Store-backed adapter; every table of a space shares the store (and its transaction). */
class StoreAdapter extends BaseDbAdapter {
  constructor(
    readonly store: Store,
    readonly log: string[],
    readonly trace: ReadTrace = { reads: [] },
  ) {
    super();
  }

  protected override _transactionOwner(): unknown {
    return this.store;
  }

  rows(): Row[] {
    const name = this._table.tableName;
    if (!this.store.has(name)) this.store.set(name, []);
    return this.store.get(name)!;
  }

  async insertOne(data: Row): Promise<TDbInsertResult> {
    const r = await this.insertMany([data]);
    return { insertedId: r.insertedIds[0] };
  }

  async insertMany(data: Row[]): Promise<TDbInsertManyResult> {
    const vc = this._table.versionColumnPhysical;
    const ids: unknown[] = [];
    for (const d of data) {
      const row = { ...d };
      if (row.id === undefined) {
        row.id = Math.max(0, ...this.rows().map((r) => Number(r.id) || 0)) + 1;
      }
      if (vc && row[vc] === undefined) row[vc] = 0;
      if (this.rows().some((r) => r.id === row.id)) {
        throw new DbError("CONFLICT", [{ path: "id", message: "duplicate key" }]);
      }
      this.rows().push(row);
      ids.push(row.id);
    }
    this.log.push(`insert:${this._table.tableName}`);
    return { insertedCount: ids.length, insertedIds: ids };
  }

  private _writeOne(filter: FilterExpr, expected: number | undefined, apply: (r: Row) => void) {
    const vc = this._table.versionColumnPhysical;
    const row = this.rows().find(
      (r) => matchesFilter(r, filter) && (expected === undefined || r[vc!] === expected),
    );
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    const version = vc ? (row[vc] as number) : undefined;
    apply(row);
    if (vc) row[vc] = (version ?? 0) + 1;
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async replaceOne(filter: FilterExpr, data: Row, expected?: number): Promise<TDbUpdateResult> {
    this.log.push(`replace:${this._table.tableName}`);
    return this._writeOne(filter, expected, (row) => {
      for (const k of Object.keys(row)) delete row[k];
      Object.assign(row, data);
    });
  }

  async updateOne(
    filter: FilterExpr,
    data: Row,
    _ops?: unknown,
    expected?: number,
  ): Promise<TDbUpdateResult> {
    this.log.push(`update:${this._table.tableName}`);
    return this._writeOne(filter, expected, (row) => Object.assign(row, data));
  }

  async deleteOne(filter: FilterExpr): Promise<TDbDeleteResult> {
    const rows = this.rows();
    const idx = rows.findIndex((r) => matchesFilter(r, filter));
    if (idx === -1) return { deletedCount: 0 };
    rows.splice(idx, 1);
    return { deletedCount: 1 };
  }

  async findOne(query: DbQuery): Promise<Row | null> {
    return (await this.findMany(query))[0] ?? null;
  }

  async findMany(query: DbQuery): Promise<Row[]> {
    const name = this._table.tableName;
    const rows = this.rows()
      .filter((r) => matchesFilter(r, query.filter ?? {}))
      .map((r) => structuredClone(r));
    this.trace.reads.push(name);
    this.trace.afterRead?.(name);
    return rows;
  }

  async count(query: DbQuery): Promise<number> {
    return (await this.findMany(query)).length;
  }

  async updateMany(filter: FilterExpr, data: Row): Promise<TDbUpdateResult> {
    let n = 0;
    for (const row of this.rows()) {
      if (matchesFilter(row, filter)) {
        Object.assign(row, data);
        n++;
      }
    }
    return { matchedCount: n, modifiedCount: n };
  }

  async replaceMany(): Promise<TDbUpdateResult> {
    return { matchedCount: 0, modifiedCount: 0 };
  }

  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    const rows = this.rows();
    const keep = rows.filter((r) => !matchesFilter(r, filter));
    const deletedCount = rows.length - keep.length;
    rows.splice(0, rows.length, ...keep);
    return { deletedCount };
  }

  async syncIndexes(): Promise<void> {}
  async ensureTable(): Promise<void> {}
}

/** Same store, with real (snapshot-restoring) transactions. */
class TxStoreAdapter extends StoreAdapter {
  protected override async _beginTransaction(): Promise<unknown> {
    this.log.push("begin");
    const snapshot = new Map<string, Row[]>();
    for (const [name, rows] of this.store) {
      snapshot.set(name, structuredClone(rows));
    }
    return snapshot;
  }

  protected override async _commitTransaction(): Promise<void> {
    this.log.push("commit");
  }

  protected override async _rollbackTransaction(state: unknown): Promise<void> {
    this.log.push("rollback");
    this.store.clear();
    for (const [name, rows] of state as Store) this.store.set(name, rows);
  }
}

function createSpace(transactional = true) {
  const store: Store = new Map();
  const log: string[] = [];
  const trace: ReadTrace = { reads: [] };
  const space = new DbSpace(() =>
    transactional ? new TxStoreAdapter(store, log, trace) : new StoreAdapter(store, log, trace),
  );
  for (const t of [WiSlug, WiUser, WiTag, WiProject, WiNote, WiProjectTag, WiCounter]) {
    space.getTable(t);
  }
  const rows = (name: string) => structuredClone(store.get(name) ?? []);
  const seed = (name: string, data: Row[]) => store.set(name, structuredClone(data));
  return {
    space,
    store,
    log,
    trace,
    /** Reads of `table` since the last call (resets the log). */
    readsOf: (table: string) => {
      const n = trace.reads.filter((t) => t === table).length;
      trace.reads.length = 0;
      return n;
    },
    rows,
    seed,
    table: (t: unknown) => space.getTable(t as never) as any,
  };
}

beforeAll(async () => {
  await prepareFixtures();
  ({ WiSlug, WiUser, WiTag, WiProject, WiNote, WiProjectTag, WiCounter } =
    await import("./fixtures/write-integrity.as"));
});

// ── 1. PK-first id resolution ────────────────────────────────────────────────

describe("PK-first id resolution", () => {
  let h: ReturnType<typeof createSpace>;
  let slugs: any;

  beforeEach(() => {
    h = createSpace();
    // "abc" is the PK of one row AND the unique slug of an EARLIER row.
    h.seed("wi_slugs", [
      { id: "zz-b", slug: "abc", title: "foreign", version: 7 },
      { id: "abc", slug: "a-own", title: "own", version: 1 },
    ]);
    slugs = h.table(WiSlug);
  });

  it("resolveIdFilter stays the $or over every compatible identification", () => {
    expect(slugs.resolveIdFilter("abc")).toEqual({ $or: [{ id: "abc" }, { slug: "abc" }] });
  });

  it("resolveRowFilter prefers the primary-key row", async () => {
    expect(await slugs.resolveRowFilter("abc")).toEqual({ id: "abc" });
    expect(await slugs.resolveRowFilter("zz-b")).toEqual({ id: "zz-b" });
  });

  it("resolveRowFilter falls back to the unique key and pins that row's primary key", async () => {
    expect(await slugs.resolveRowFilter("a-own")).toEqual({ id: "abc" });
  });

  it("resolveRowFilter answers the first identification when nothing matches", async () => {
    expect(await slugs.resolveRowFilter("nope")).toEqual({ id: "nope" });
  });

  it("an object id carrying the complete primary key resolves by the primary key alone", async () => {
    expect(await slugs.resolveRowFilter({ id: "nope", slug: "abc" })).toEqual({ id: "nope" });
    expect(await slugs.resolveRowFilter({ slug: "abc" })).toEqual({ slug: "abc" });
  });

  it("findById returns the primary-key row", async () => {
    expect(await slugs.findById("abc")).toMatchObject({ id: "abc", title: "own" });
    expect(await slugs.findById("a-own")).toMatchObject({ id: "abc", title: "own" });
  });

  it("deleteOne deletes the primary-key row, never the unique-key namesake", async () => {
    const result = await slugs.deleteOne("abc");
    expect(result).toEqual({ deletedCount: 1 });
    expect(h.rows("wi_slugs").map((r) => r.id)).toEqual(["zz-b"]);
    expect(h.log).toContain("begin"); // ambiguous id → pinned inside a transaction
  });

  it("deleteOne falls back to the unique key when no row has that primary key", async () => {
    await slugs.deleteOne("a-own");
    expect(h.rows("wi_slugs").map((r) => r.id)).toEqual(["zz-b"]);
  });

  it("the delete guard's filter and current() name the row the delete targets", async () => {
    let seen: any;
    await slugs.deleteOne("abc", {
      guard: async (ctx: any) => {
        seen = { filter: ctx.filter, current: await ctx.current() };
      },
    });
    expect(seen.filter).toEqual({ id: "abc" });
    expect(seen.current).toMatchObject({ id: "abc", title: "own" });
    expect(h.rows("wi_slugs").map((r) => r.id)).toEqual(["zz-b"]);
  });

  // since 0.1.143 — `scope`: an out-of-scope row never shadows an in-scope one.
  it("resolveRowFilter with a scope: an out-of-scope PK row does not shadow an in-scope unique row", async () => {
    const scope = { title: "foreign" };
    const shadowed = await slugs.resolveRowFilter("abc", { scope });
    // The same answer as if the out-of-scope PK row did not exist.
    const alone = createSpace();
    alone.seed("wi_slugs", [{ id: "zz-b", slug: "abc", title: "foreign", version: 7 }]);
    const unshadowed = await alone.table(WiSlug).resolveRowFilter("abc", { scope });
    expect(shadowed).toEqual({ id: "zz-b" });
    expect(unshadowed).toEqual(shadowed);
    // Nothing in scope → the first identification, exactly as for a missing row.
    expect(await slugs.resolveRowFilter("abc", { scope: { title: "none" } })).toEqual({
      id: "abc",
    });
    // An empty scope is no scope.
    expect(await slugs.resolveRowFilter("abc", { scope: {} })).toEqual({ id: "abc" });
  });

  it("deleteOne with a scope pins among in-scope rows and never deletes an out-of-scope one", async () => {
    expect(await slugs.deleteOne("abc", { scope: { title: "foreign" } })).toEqual({
      deletedCount: 1,
    });
    expect(h.rows("wi_slugs").map((r) => r.id)).toEqual(["abc"]);

    let current: unknown = "unset";
    const result = await slugs.deleteOne("abc", {
      scope: { title: "none" },
      guard: async (ctx: any) => {
        current = await ctx.current();
      },
    });
    expect(result).toEqual({ deletedCount: 0 });
    expect(current).toBeNull();
    expect(h.rows("wi_slugs").map((r) => r.id)).toEqual(["abc"]);
  });

  it("the write guard's current(i) reads the row the write targets (primary key first)", async () => {
    let current: any;
    await slugs.updateOne(
      { id: "abc", slug: "abc", title: "x" },
      {
        guard: async (ctx: any) => {
          current = await ctx.current(0);
        },
      },
    );
    expect(current).toMatchObject({ id: "abc", title: "own" });
    expect(h.rows("wi_slugs").find((r) => r.id === "zz-b")).toMatchObject({ title: "foreign" });
  });

  it("filterFor(i) / currentAll(): primary key first, else the unique key — one row each", async () => {
    let filters: unknown[] = [];
    let all: any[] = [];
    let inScope = -1;
    await slugs.bulkUpdate(
      [
        { id: "abc", slug: "abc", title: "x" },
        { slug: "abc", title: "y" },
      ],
      {
        guard: async (ctx: any) => {
          filters = [ctx.filterFor(0), ctx.filterFor(1)];
          all = await ctx.currentAll();
          // The USING recipe: one count over the batch's exact filters.
          inScope = await slugs.count({
            filter: { $and: [{ $or: filters }, { title: "own" }] },
          });
        },
      },
    );
    expect(filters).toEqual([{ id: "abc" }, { slug: "abc" }]);
    expect(all.map((r) => r?.id)).toEqual(["abc", "zz-b"]);
    expect(inScope).toBe(1);
  });
});

// ── 2. Nested-writer integrity ───────────────────────────────────────────────

function seedGraph(h: ReturnType<typeof createSpace>) {
  h.seed("wi_users", [
    { id: 1, name: "u1" },
    { id: 2, name: "u2" },
  ]);
  h.seed("wi_projects", [
    { id: 1, title: "p1", ownerId: 1, version: 1 },
    { id: 2, title: "p2", ownerId: 2, version: 1 },
  ]);
  h.seed("wi_notes", [
    { id: 1, body: "n1", projectId: 1 },
    { id: 2, body: "n2", projectId: 2 },
    { id: 3, body: "orphan", projectId: null },
  ]);
  h.seed("wi_tags", [
    { id: 1, name: "t1" },
    { id: 2, name: "t2" },
  ]);
  h.seed("wi_project_tags", [{ id: 1, projectId: 1, tagId: 1 }]);
}

describe.each([
  ["transactional adapter", true],
  ["pass-through adapter", false],
])("nested-writer integrity (%s)", (_label, transactional) => {
  let h: ReturnType<typeof createSpace>;
  let projects: any;
  const note = (id: number) => h.rows("wi_notes").find((r) => r.id === id);
  const tag = (id: number) => h.rows("wi_tags").find((r) => r.id === id);

  beforeEach(() => {
    h = createSpace(transactional);
    seedGraph(h);
    projects = h.table(WiProject);
  });

  describe("FROM", () => {
    it("$update of another parent's child → CONFLICT, nothing re-parented", async () => {
      await expect(
        projects.updateOne({ id: 1, title: "t", notes: { $update: [{ id: 2, body: "stolen" }] } }),
      ).rejects.toMatchObject({ code: "CONFLICT", errors: [{ path: "notes" }] });
      expect(note(2)).toMatchObject({ body: "n2", projectId: 2 });
    });

    it("$update of an orphan child → CONFLICT", async () => {
      await expect(
        projects.updateOne({ id: 1, notes: { $update: [{ id: 3, body: "adopted" }] } }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(note(3)).toMatchObject({ body: "orphan", projectId: null });
    });

    it("$update of an own child works", async () => {
      await projects.updateOne({ id: 1, notes: { $update: [{ id: 1, body: "edited" }] } });
      expect(note(1)).toMatchObject({ body: "edited", projectId: 1 });
    });

    it("$update entries must carry the child primary key", async () => {
      await expect(
        projects.updateOne({ id: 1, notes: { $update: [{ body: "no key" }] } }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", errors: [{ path: "notes.$update[0].id" }] });
    });

    it("$upsert with another parent's child key → CONFLICT", async () => {
      await expect(
        projects.updateOne({ id: 1, notes: { $upsert: [{ id: 2, body: "stolen2" }] } }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(note(2)).toMatchObject({ body: "n2", projectId: 2 });
    });

    it("$replace with another parent's child → CONFLICT, own children not deleted", async () => {
      await expect(
        projects.updateOne({ id: 1, notes: { $replace: [{ id: 2, body: "replaced" }] } }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(note(1)).toMatchObject({ projectId: 1 });
      expect(note(2)).toMatchObject({ body: "n2", projectId: 2 });
    });

    it("replaceOne with a plain array naming another parent's child → CONFLICT", async () => {
      await expect(
        projects.replaceOne({ id: 1, title: "p1", notes: [{ id: 2, body: "mine now" }] }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(note(1)).toMatchObject({ projectId: 1 });
      expect(note(2)).toMatchObject({ body: "n2", projectId: 2 });
    });

    it("replaceOne keeps / rewrites own children", async () => {
      await projects.replaceOne({ id: 1, title: "p1", notes: [{ id: 1, body: "kept" }] });
      expect(note(1)).toMatchObject({ body: "kept", projectId: 1 });
    });
  });

  describe("VIA", () => {
    it("$update of an unlinked target → CONFLICT", async () => {
      await expect(
        projects.updateOne({ id: 1, tags: { $update: [{ id: 2, name: "pwned" }] } }),
      ).rejects.toMatchObject({ code: "CONFLICT", errors: [{ path: "tags" }] });
      expect(tag(2)).toMatchObject({ name: "t2" });
    });

    it("$update of a linked target works", async () => {
      await projects.updateOne({ id: 1, tags: { $update: [{ id: 1, name: "renamed" }] } });
      expect(tag(1)).toMatchObject({ name: "renamed" });
    });

    it("$upsert of an unlinked target → CONFLICT, no link created", async () => {
      await expect(
        projects.updateOne({ id: 1, tags: { $upsert: [{ id: 2, name: "pwned" }] } }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(tag(2)).toMatchObject({ name: "t2" });
      expect(h.rows("wi_project_tags")).toHaveLength(1);
    });

    it("$upsert without a key inserts + links; $insert by key still links", async () => {
      await projects.updateOne({
        id: 1,
        tags: { $upsert: [{ name: "fresh" }], $insert: [{ id: 2 }] },
      });
      const links = h.rows("wi_project_tags").filter((l) => l.projectId === 1);
      expect(links.map((l) => l.tagId).toSorted((a, b) => Number(a) - Number(b))).toEqual([
        1, 2, 3,
      ]);
    });
  });

  describe("nested phases are skipped when the main write matched nothing", () => {
    it("stale $cas on update → no TO / FROM / VIA writes", async () => {
      const result = await projects.updateOne({
        id: 1,
        $cas: { version: 99 },
        owner: { name: "hijacked" },
        notes: { $insert: [{ id: 10, body: "x" }] },
        tags: { $insert: [{ id: 2 }] },
      });
      expect(result).toEqual({ matchedCount: 0, modifiedCount: 0 });
      expect(h.rows("wi_users").find((u) => u.id === 1)).toMatchObject({ name: "u1" });
      expect(note(10)).toBeUndefined();
      expect(h.rows("wi_project_tags")).toHaveLength(1);
    });

    it("update of a missing row → no nested writes", async () => {
      const result = await projects.updateOne({
        id: 99,
        owner: { name: "ghost" },
        notes: { $insert: [{ id: 11, body: "x" }] },
      });
      expect(result.matchedCount).toBe(0);
      expect(note(11)).toBeUndefined();
      expect(h.rows("wi_users").map((u) => u.name)).toEqual(["u1", "u2"]);
    });

    it("stale $cas on replace → no TO / FROM writes", async () => {
      const result = await projects.replaceOne({
        id: 1,
        title: "p1",
        $cas: { version: 99 },
        owner: { id: 1, name: "overwritten" },
        notes: [{ id: 12, body: "x" }],
      });
      expect(result.matchedCount).toBe(0);
      expect(h.rows("wi_users").find((u) => u.id === 1)).toMatchObject({ name: "u1" });
      expect(note(12)).toBeUndefined();
      expect(note(1)).toMatchObject({ projectId: 1 });
    });

    it("replace of a missing row → the nested TO row is not written", async () => {
      const result = await projects.replaceOne({
        id: 99,
        title: "ghost",
        owner: { id: 2, name: "overwritten" },
      });
      expect(result.matchedCount).toBe(0);
      expect(h.rows("wi_users").find((u) => u.id === 2)).toMatchObject({ name: "u2" });
    });
  });
});

// ── 2b. Read-once resolution + batched nested plans (0.1.143) ──────────────

describe("single-read id resolution", () => {
  let h: ReturnType<typeof createSpace>;
  let slugs: any;

  beforeEach(() => {
    h = createSpace();
    h.seed("wi_slugs", [
      { id: "zz-b", slug: "abc", title: "foreign", version: 7 },
      { id: "abc", slug: "a-own", title: "own", version: 1 },
    ]);
    slugs = h.table(WiSlug);
    h.readsOf("wi_slugs");
  });

  it("resolveRowFilter pins an ambiguous id in ONE read", async () => {
    expect(await slugs.resolveRowFilter("abc")).toEqual({ id: "abc" });
    expect(h.readsOf("wi_slugs")).toBe(1);
    expect(await slugs.resolveRowFilter("a-own")).toEqual({ id: "abc" });
    expect(h.readsOf("wi_slugs")).toBe(1);
  });

  it("findOneByRow returns the addressed row directly (no pin-then-reread)", async () => {
    expect(await slugs.findOneByRow("abc")).toMatchObject({ id: "abc", title: "own" });
    expect(h.readsOf("wi_slugs")).toBe(1);
    expect(await slugs.findOneByRow("a-own")).toMatchObject({ id: "abc" });
    expect(await slugs.findOneByRow("nope")).toBeNull();
  });

  it("findOneByRow: the scope pins among in-scope rows and filters the result", async () => {
    expect(await slugs.findOneByRow("abc", { scope: { title: "foreign" } })).toMatchObject({
      id: "zz-b",
    });
    expect(await slugs.findOneByRow("abc", { scope: { title: "none" } })).toBeNull();
    expect(await slugs.findOneByRow("zz-b", { scope: { title: "own" } })).toBeNull();
  });

  it("findOneByRow reads with the caller's controls", async () => {
    const spy = vi.spyOn(slugs, "findOne");
    await slugs.findOneByRow("abc", { controls: { $select: ["title"] } });
    expect(spy.mock.calls[0]![0]).toMatchObject({
      filter: { id: "abc" },
      controls: { $select: ["title"] },
    });
  });

  it("recordFilter is the write's own record resolution", () => {
    expect(slugs.recordFilter({ id: "abc", slug: "zz" })).toEqual({ id: "abc" });
    expect(slugs.recordFilter({ slug: "abc", title: "x" })).toEqual({ slug: "abc" });
    expect(() => slugs.recordFilter({ title: "x" })).toThrow(DbError);
  });
});

describe("batched nested plans + pinned write targets", () => {
  let h: ReturnType<typeof createSpace>;
  let projects: any;
  const note = (id: number) => h.rows("wi_notes").find((r) => r.id === id);

  beforeEach(() => {
    h = createSpace();
    seedGraph(h);
    h.seed("wi_project_tags", [
      { id: 1, projectId: 1, tagId: 1 },
      { id: 2, projectId: 2, tagId: 2 },
    ]);
    projects = h.table(WiProject);
    h.trace.reads.length = 0;
  });

  it("no nested value → no plan reads", async () => {
    await projects.updateOne({ id: 1, title: "x" });
    expect(h.readsOf("wi_notes") + h.readsOf("wi_project_tags")).toBe(0);
  });

  it("FROM ownership: ONE read for the whole batch", async () => {
    await projects.bulkUpdate([
      { id: 1, notes: { $update: [{ id: 1, body: "a" }] } },
      { id: 2, notes: { $update: [{ id: 2, body: "b" }] } },
    ]);
    expect(h.readsOf("wi_notes")).toBe(1);
    expect(note(1)).toMatchObject({ body: "a", projectId: 1 });
    expect(note(2)).toMatchObject({ body: "b", projectId: 2 });
  });

  it("FROM ownership: a stranger anywhere in the batch rejects it before any write", async () => {
    await expect(
      projects.bulkUpdate([
        { id: 1, title: "changed", notes: { $update: [{ id: 1, body: "a" }] } },
        { id: 2, notes: { $upsert: [{ id: 1, body: "stolen" }] } },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.rows("wi_projects").find((p) => p.id === 1)).toMatchObject({ title: "p1" });
    expect(note(1)).toMatchObject({ body: "n1", projectId: 1 });
  });

  it("VIA links: ONE junction read for the whole batch", async () => {
    await projects.bulkUpdate([
      { id: 1, tags: { $update: [{ id: 1, name: "x" }] } },
      { id: 2, tags: { $update: [{ id: 2, name: "y" }] } },
    ]);
    expect(h.readsOf("wi_project_tags")).toBe(1);
    expect(h.rows("wi_tags").map((t) => t.name)).toEqual(["x", "y"]);
  });

  it("a child re-parented between the plan and the write → CONFLICT, rolled back", async () => {
    let moved = false;
    h.trace.afterRead = (table) => {
      if (table !== "wi_notes" || moved) return;
      moved = true;
      h.store.get("wi_notes")!.find((r) => r.id === 1)!.projectId = 2;
    };
    await expect(
      projects.updateOne({ id: 1, title: "changed", notes: { $update: [{ id: 1, body: "x" }] } }),
    ).rejects.toMatchObject({ code: "CONFLICT", errors: [{ path: "notes" }] });
    expect(h.log.at(-1)).toBe("rollback");
    expect(note(1)).toMatchObject({ body: "n1" });
    expect(h.rows("wi_projects").find((p) => p.id === 1)).toMatchObject({ title: "p1" });
  });

  it("$replace deletes only the parent's own orphans", async () => {
    h.seed("wi_notes", [
      { id: 1, body: "n1", projectId: 1 },
      { id: 4, body: "n4", projectId: 1 },
      { id: 2, body: "n2", projectId: 2 },
    ]);
    await projects.replaceOne({ id: 1, title: "p1", notes: [{ id: 1, body: "kept" }] });
    expect(h.rows("wi_notes").map((n) => [n.id, n.body])).toEqual([
      [1, "kept"],
      [2, "n2"],
    ]);
  });

  it("nested TO patches of a batch pin the source rows in ONE read", async () => {
    await projects.bulkUpdate([
      { id: 1, title: "t1", owner: { name: "o1" } },
      { id: 2, title: "t2", owner: { name: "o2" } },
    ]);
    expect(h.readsOf("wi_projects")).toBe(1);
    expect(h.rows("wi_users").map((u) => u.name)).toEqual(["o1", "o2"]);
  });

  it("the guard's current(i) pre-image is reused by the write's pin", async () => {
    await projects.updateOne(
      { id: 1, title: "t", owner: { name: "g" } },
      {
        guard: async (ctx: any) => {
          await ctx.current(0);
        },
      },
    );
    expect(h.readsOf("wi_projects")).toBe(1);
    expect(h.rows("wi_users").find((u) => u.id === 1)).toMatchObject({ name: "g" });
  });
});

// ── 3. Post-write check ──────────────────────────────────────────────────────

/** A check that records its context and counts every filter inside the transaction. */
function capture() {
  const calls: Array<TDbWriteCheckContext & { seen: Record<string, number> }> = [];
  const check = vi.fn(async (ctx: TDbWriteCheckContext) => {
    const seen: Record<string, number> = {};
    for (const f of ctx.filters) seen[JSON.stringify(f)] = await ctx.count(f);
    calls.push({ ...ctx, seen });
  });
  return { check, calls };
}

describe("post-write check", () => {
  let h: ReturnType<typeof createSpace>;

  beforeEach(() => {
    h = createSpace();
    seedGraph(h);
  });

  it("insertOne: resulting (auto-increment) PK, inside the transaction, after the write", async () => {
    const { check, calls } = capture();
    const counters = h.table(WiCounter);
    await counters.insertOne({ name: "a" }, { check });
    expect(check).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({
      action: "insert",
      filters: [{ id: 1 }],
      transactional: true,
      seen: { '{"id":1}': 1 },
    });
    expect(h.log).toEqual(["begin", "insert:wi_counters", "commit"]);
  });

  it("insertMany: one call for the batch, after every nested phase", async () => {
    const { calls } = capture();
    let notesAtCheck = -1;
    const projects = h.table(WiProject);
    await projects.insertMany(
      [
        { id: 5, title: "a", notes: [{ id: 50, body: "n" }] },
        { id: 6, title: "b" },
      ],
      {
        check: async (ctx: TDbWriteCheckContext) => {
          calls.push(ctx as never);
          notesAtCheck = await h.table(WiNote).count({ filter: { projectId: 5 }, controls: {} });
        },
      },
    );
    expect(calls).toHaveLength(1); // never for the nested re-entry on wi_notes
    expect(calls[0]).toMatchObject({ action: "insertMany", filters: [{ id: 5 }, { id: 6 }] });
    expect(notesAtCheck).toBe(1);
  });

  it("update identified by a unique key → the target row's exact primary key", async () => {
    h.seed("wi_slugs", [{ id: "s1", slug: "one", title: "t", version: 0 }]);
    const { check, calls } = capture();
    await h.table(WiSlug).updateOne({ slug: "one", title: "u" }, { check });
    expect(calls[0]).toMatchObject({ action: "update", filters: [{ id: "s1" }] });
  });

  it("bulkUpdate: de-duplicated, rows that matched nothing are absent", async () => {
    const { check, calls } = capture();
    await h.table(WiProject).bulkUpdate(
      [
        { id: 1, title: "x" },
        { id: 1, title: "y" },
        { id: 99, title: "missing" },
        { id: 2, $cas: { version: 42 }, title: "stale" },
      ],
      { check },
    );
    expect(calls[0]).toMatchObject({ action: "updateMany", filters: [{ id: 1 }] });
  });

  it("replaceOne / bulkReplace", async () => {
    const { check, calls } = capture();
    await h.table(WiProject).replaceOne({ id: 1, title: "r" }, { check });
    await h.table(WiProject).bulkReplace(
      [
        { id: 1, title: "r1" },
        { id: 2, title: "r2" },
      ],
      { check },
    );
    expect(calls.map((c) => [c.action, c.filters])).toEqual([
      ["replace", [{ id: 1 }]],
      ["replaceMany", [{ id: 1 }, { id: 2 }]],
    ]);
  });

  it("a row-level WITH CHECK: a throw rolls the write back and propagates unchanged", async () => {
    const denied = new Error("row leaves the caller's scope");
    const withCheck = async (ctx: TDbWriteCheckContext) => {
      const inScope = await ctx.count({ $and: [{ $or: ctx.filters }, { ownerId: 1 }] });
      if (inScope !== ctx.filters.length) throw denied;
    };
    const projects = h.table(WiProject);
    await projects.updateOne({ id: 1, title: "still mine" }, { check: withCheck });
    await expect(projects.updateOne({ id: 1, ownerId: 2 }, { check: withCheck })).rejects.toBe(
      denied,
    );
    expect(h.rows("wi_projects").find((p) => p.id === 1)).toMatchObject({
      title: "still mine",
      ownerId: 1,
    });
    expect(h.log.at(-1)).toBe("rollback");
  });

  it("transactional is false on a pass-through adapter", async () => {
    const pass = createSpace(false);
    const { check, calls } = capture();
    await pass.table(WiCounter).insertOne({ name: "a" }, { check });
    expect(calls[0]).toMatchObject({ transactional: false, filters: [{ id: 1 }] });
  });
});
