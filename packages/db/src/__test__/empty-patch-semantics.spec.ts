import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { DbSpace } from "../table/db-space";
import { AtscriptDbTable } from "../table/db-table";
import { withOptimisticRetry } from "../with-optimistic-retry";
import { MockAdapter, prepareFixtures } from "./test-utils";

/**
 * Empty-patch semantics (since 0.1.128) — the three-way split in
 * `bulkUpdate` Phase 2 replaces the former fabricated `{ 1, 0 }` short-circuit:
 *
 *  1. empty + `$cas`    → the CAS statement EXECUTES ("versioned touch"):
 *                         hit → adapter result (bump), stale/missing → { 0, 0 }
 *  2. empty + no `$cas` → no statement; `matchedCount` comes from one count
 *  3. non-empty         → unchanged
 *
 * `updateMany(filter, {})` → count path (never an empty SET), and
 * `withOptimisticRetry` treats a mutator returning `undefined` / `{}` as an
 * explicit no-write.
 */

let VersionedUser: any;
let PlainWidget: any;
let Post: any;
let Author: any;

beforeAll(async () => {
  await prepareFixtures();
  const v = await import("./fixtures/version-tables.as");
  VersionedUser = v.VersionedUser;
  PlainWidget = v.PlainWidget;
  const rel = await import("./fixtures/test-relations.as");
  const author = await import("./fixtures/rel-author.as");
  Post = rel.Post;
  Author = author.Author;
});

function makeTable(type: any): { table: AtscriptDbTable; adapter: MockAdapter } {
  const adapter = new MockAdapter();
  const table = new AtscriptDbTable(type, adapter);
  return { table, adapter };
}

describe("empty patch + $cas — versioned touch executes the CAS statement", () => {
  // WHY: I1 — a CAS predicate is never silently dropped. The former
  // short-circuit returned { 1, 0 } without consulting the adapter at all.
  it("PK-only payload with $cas calls adapter.updateOne(filter, {}, undefined, expectedVersion)", async () => {
    const { table, adapter } = makeTable(VersionedUser);
    adapter.store.set("versioned_users", [{ id: 1, name: "Ada", version: 4 }]);
    const updateOne = vi.spyOn(adapter, "updateOne");
    const count = vi.spyOn(adapter, "count");

    const result = await table.updateOne({ id: 1, $cas: { version: 4 } } as any);

    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne.mock.calls[0]).toEqual([{ id: 1 }, {}, undefined, 4]);
    expect(count).not.toHaveBeenCalled();
    // The adapter's report is passed through verbatim (MockAdapter → { 1, 1 }).
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
  });

  // WHY: I3 — a stale or missing row reports what the store reported.
  it("passes the adapter's { 0, 0 } through on a stale/missing CAS touch", async () => {
    const { table, adapter } = makeTable(VersionedUser);
    vi.spyOn(adapter, "updateOne").mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

    const result = await table.updateOne({ id: 404, $cas: { version: 4 } } as any);

    expect(result).toEqual({ matchedCount: 0, modifiedCount: 0 });
  });

  // WHY: the touch goes through the native-patch branch on adapters that have
  // one, so Mongo's `$inc: { version: 1 }` pipeline is what executes.
  it("routes the touch through nativePatch on native-patch adapters", async () => {
    const { table, adapter } = makeTable(VersionedUser);
    vi.spyOn(adapter, "supportsNativePatch").mockReturnValue(true);
    const nativePatch = vi
      .spyOn(adapter, "nativePatch")
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const updateOne = vi.spyOn(adapter, "updateOne");

    await table.updateOne({ id: 1, $cas: { version: 2 } } as any);

    expect(nativePatch).toHaveBeenCalledTimes(1);
    expect(nativePatch.mock.calls[0]).toEqual([{ id: 1 }, {}, undefined, 2]);
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe("empty patch without $cas — honest count, no statement", () => {
  // WHY: I2 — a no-op must not bump the version (that would invalidate every
  // other client's CAS), but I3 forbids fabricating the match.
  it("reports { 1, 0 } from adapter.count when the row exists, without any write", async () => {
    const { table, adapter } = makeTable(VersionedUser);
    adapter.store.set("versioned_users", [{ id: 1, name: "Ada", version: 4 }]);
    const updateOne = vi.spyOn(adapter, "updateOne");
    const nativePatch = vi.spyOn(adapter, "nativePatch");
    const count = vi.spyOn(adapter, "count");

    const result = await table.updateOne({ id: 1 } as any);

    expect(result).toEqual({ matchedCount: 1, modifiedCount: 0 });
    expect(updateOne).not.toHaveBeenCalled();
    expect(nativePatch).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0]?.[0]).toEqual({ filter: { id: 1 }, controls: {} });
  });

  it("reports { 0, 0 } when the row is missing", async () => {
    const { table } = makeTable(VersionedUser);
    const result = await table.updateOne({ id: 999 } as any);
    expect(result).toEqual({ matchedCount: 0, modifiedCount: 0 });
  });

  it("applies to non-versioned tables too", async () => {
    const { table, adapter } = makeTable(PlainWidget);
    adapter.store.set("plain_widgets", [{ id: 7, name: "w" }]);
    const updateOne = vi.spyOn(adapter, "updateOne");
    expect(await table.updateOne({ id: 7 } as any)).toEqual({ matchedCount: 1, modifiedCount: 0 });
    expect(await table.updateOne({ id: 8 } as any)).toEqual({ matchedCount: 0, modifiedCount: 0 });
    expect(updateOne).not.toHaveBeenCalled();
  });

  // WHY: nav-only patches ({ id, author: {…} }) land on the count path for the
  // root row — the related row is still patched by Phase 1.
  it("nav-only patch still patches the TO table and reports root existence", async () => {
    const space = new DbSpace(() => new MockAdapter());
    const posts = space.getTable(Post) as AtscriptDbTable;
    const authors = space.getTable(Author) as AtscriptDbTable;
    const postAdapter = posts.getAdapter() as MockAdapter;
    const authorAdapter = authors.getAdapter() as MockAdapter;
    postAdapter.store.set("posts", [{ id: 1, title: "t", status: "draft", authorId: 5 }]);
    authorAdapter.store.set("authors", [{ id: 5, name: "old" }]);
    const rootUpdate = vi.spyOn(postAdapter, "updateOne");
    const authorUpdate = vi.spyOn(authorAdapter, "updateOne");

    const result = await posts.updateOne({ id: 1, author: { name: "new" } } as any);

    expect(authorUpdate).toHaveBeenCalledTimes(1);
    expect(authorUpdate.mock.calls[0]?.[0]).toEqual({ id: 5 });
    expect(authorUpdate.mock.calls[0]?.[1]).toEqual({ name: "new" });
    expect(rootUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 0 });
  });

  // WHY: bulk mixes the three branches per item and aggregates honestly.
  it("bulkUpdate mixes touch / count / regular items", async () => {
    const { table, adapter } = makeTable(VersionedUser);
    adapter.store.set("versioned_users", [
      { id: 1, name: "A", version: 4 },
      { id: 2, name: "B", version: 0 },
      { id: 3, name: "C", version: 0 },
    ]);
    const updateOne = vi.spyOn(adapter, "updateOne");
    const count = vi.spyOn(adapter, "count");

    const result = await table.bulkUpdate([
      { id: 1, $cas: { version: 4 } }, // touch → statement
      { id: 2 }, // count only
      { id: 3, name: "C2" }, // regular
      { id: 404 }, // count only, missing
    ] as any[]);

    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne.mock.calls[0]).toEqual([{ id: 1 }, {}, undefined, 4]);
    expect(updateOne.mock.calls[1]?.[0]).toEqual({ id: 3 });
    expect(count).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ matchedCount: 3, modifiedCount: 2 });
  });
});

describe("updateMany with an empty patch", () => {
  // WHY: an empty SET list is a SQL syntax error, and a bulk no-op must not
  // bump versions — report the honest match count only.
  it("updateMany(filter, {}) counts instead of issuing an UPDATE", async () => {
    const { table, adapter } = makeTable(VersionedUser);
    adapter.store.set("versioned_users", [
      { id: 1, name: "A", version: 0 },
      { id: 2, name: "A", version: 0 },
      { id: 3, name: "B", version: 0 },
    ]);
    const updateMany = vi.spyOn(adapter, "updateMany");
    const count = vi.spyOn(adapter, "count");

    const result = await table.updateMany({ name: "A" } as any, {} as any);

    expect(updateMany).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ matchedCount: 2, modifiedCount: 0 });
  });

  it("a patch that prunes to nothing ({ note: undefined }) takes the same count path", async () => {
    const { table, adapter } = makeTable(PlainWidget);
    adapter.store.set("plain_widgets", [{ id: 1, name: "w" }]);
    const updateMany = vi.spyOn(adapter, "updateMany");
    const result = await table.updateMany({} as any, { name: undefined } as any);
    expect(updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 0 });
  });

  it("ops-only patches still execute (the guard only fires on a truly empty update)", async () => {
    const { table, adapter } = makeTable(VersionedUser);
    const updateMany = vi.spyOn(adapter, "updateMany");
    await table.updateMany({} as any, { name: "x" } as any);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("withOptimisticRetry — explicit no-write", () => {
  // WHY: N concurrent read-modify-write loops whose mutators all decide
  // "nothing to change" must not bump each other into CasExhaustedError.
  it("mutator returning {} does not write and resolves { 1, 0 }", async () => {
    const { table } = makeTable(VersionedUser);
    vi.spyOn(table, "findOne").mockResolvedValue({ id: 1, name: "Ada", version: 4 } as any);
    const updateOne = vi.spyOn(table, "updateOne");

    const result = await withOptimisticRetry(table, { id: 1 }, () => ({}));

    expect(result).toEqual({ matchedCount: 1, modifiedCount: 0 });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("mutator returning undefined does not write and resolves { 1, 0 }", async () => {
    const { table } = makeTable(VersionedUser);
    vi.spyOn(table, "findOne").mockResolvedValue({ id: 1, name: "Ada", version: 4 } as any);
    const updateOne = vi.spyOn(table, "updateOne");

    const result = await withOptimisticRetry(table, { id: 1 }, () => undefined);

    expect(result).toEqual({ matchedCount: 1, modifiedCount: 0 });
    expect(updateOne).not.toHaveBeenCalled();
  });

  // WHY: the fence idiom stays available — a PK-only `$cas` update through the
  // table is a real statement.
  it("the versioned-touch idiom (updateOne with $cas only) still reaches the adapter", async () => {
    const { table, adapter } = makeTable(VersionedUser);
    const updateOne = vi.spyOn(adapter, "updateOne");
    await table.updateOne({ id: 1, $cas: { version: 0 } } as any);
    expect(updateOne).toHaveBeenCalledWith({ id: 1 }, {}, undefined, 0);
  });
});
