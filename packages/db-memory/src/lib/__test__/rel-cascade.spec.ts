import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

// Regression: an application-level cascade used to run BEFORE the delete
// filter was evaluated again, so a `$some` over the cascaded child relation
// stopped matching — children were deleted / nulled and the parent survived.
// The rows are now pinned by key once; cascade and delete both use the pin.
// A filter without a predicate keeps the single delete by its own filter.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rel-cascade.as");
});

describe("relational predicates + application-level cascades", () => {
  let tickets: any;
  let issues: any;
  let notes: any;

  beforeEach(async () => {
    const space = createTestSpace();
    await bootstrapStoredTables(space, [fx.RcTicket, fx.RcIssue, fx.RcNote]);
    tickets = space.getTable(fx.RcTicket);
    issues = space.getTable(fx.RcIssue);
    notes = space.getTable(fx.RcNote);
    await tickets.insertMany([
      { key: "T1", status: "open" },
      { key: "T2", status: "open" },
      { key: "T3", status: "closed" },
    ]);
    await issues.insertMany([
      { id: 1, title: "crash", ticketKey: "T1" },
      { id: 2, title: "other", ticketKey: "T1" },
      { id: 3, title: "typo", ticketKey: "T2" },
    ]);
    await notes.insertMany([
      { id: 1, body: "n1", ticketKey: "T1" },
      { id: 2, body: "n2", ticketKey: "T2" },
      { id: 3, body: "n3", ticketKey: "T3" },
    ]);
  });

  const keys = async (t: any) =>
    ((await t.findMany({ filter: {}, controls: {} })) as Array<Record<string, unknown>>)
      .map((r) => (r.key ?? r.id) as string | number)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  it("deleteMany by $some over the CASCADED relation deletes the parent and its children", async () => {
    const res = await tickets.deleteMany({ issues: { $some: { title: "crash" } } });
    expect(res).toEqual({ deletedCount: 1 });
    expect(await keys(tickets)).toEqual(["T2", "T3"]);
    expect(await keys(issues)).toEqual([3]);
    // setNull on the other relation ran for T1 only
    const n = await notes.findMany({ filter: {}, controls: {} });
    expect(n.find((r: any) => r.id === 1).ticketKey ?? null).toBeNull();
    expect(n.find((r: any) => r.id === 2).ticketKey).toBe("T2");
  });

  it("deleteMany by $some over the SET-NULL relation deletes the parent", async () => {
    const res = await tickets.deleteMany({ notes: { $some: { body: { $in: ["n1", "n2"] } } } });
    expect(res).toEqual({ deletedCount: 2 });
    expect(await keys(tickets)).toEqual(["T3"]);
    const n = await notes.findMany({ filter: {}, controls: {} });
    expect(n.map((r: any) => r.ticketKey ?? null)).toEqual([null, null, "T3"]);
    expect(await keys(issues)).toEqual([]);
  });

  it("deleteMany with $none still pins: no unrelated row is deleted", async () => {
    const res = await tickets.deleteMany({ issues: { $none: {} } });
    expect(res).toEqual({ deletedCount: 1 });
    expect(await keys(tickets)).toEqual(["T1", "T2"]);
  });

  it("deleteMany matching nothing deletes nothing", async () => {
    expect(await tickets.deleteMany({ issues: { $some: { title: "zzz" } } })).toEqual({
      deletedCount: 0,
    });
    expect(await keys(tickets)).toEqual(["T1", "T2", "T3"]);
    expect(await keys(issues)).toEqual([1, 2, 3]);
  });

  it("deleteOne with a $some row scope over the cascaded relation", async () => {
    const res = await tickets.deleteOne("T1", { scope: { issues: { $some: { title: "crash" } } } });
    expect(res).toEqual({ deletedCount: 1 });
    expect(await keys(tickets)).toEqual(["T2", "T3"]);
    // every child of T1 cascaded (not only the one the scope matched)
    expect(await keys(issues)).toEqual([3]);
  });

  it("deleteOne with a $some row scope over the set-null relation", async () => {
    const res = await tickets.deleteOne("T2", { scope: { notes: { $some: { body: "n2" } } } });
    expect(res).toEqual({ deletedCount: 1 });
    expect(await keys(tickets)).toEqual(["T1", "T3"]);
    const n = await notes.findMany({ filter: {}, controls: {} });
    expect(n.find((r: any) => r.id === 2).ticketKey ?? null).toBeNull();
  });

  it("a predicate-free filter deletes by its own filter (no key pin)", async () => {
    const adapter = tickets.dbAdapter;
    const seen: unknown[] = [];
    const deleteMany = adapter.deleteMany.bind(adapter);
    adapter.deleteMany = (filter: unknown) => {
      seen.push(filter);
      return deleteMany(filter);
    };
    expect(await tickets.deleteMany({ status: "open" })).toEqual({ deletedCount: 2 });
    expect(seen).toEqual([{ status: "open" }]);
    expect(await keys(tickets)).toEqual(["T3"]);
    expect(await keys(issues)).toEqual([]);
  });

  it("deleteOne out of scope touches nothing", async () => {
    const res = await tickets.deleteOne("T1", { scope: { issues: { $some: { title: "typo" } } } });
    expect(res).toEqual({ deletedCount: 0 });
    expect(await keys(tickets)).toEqual(["T1", "T2", "T3"]);
    expect(await keys(issues)).toEqual([1, 2, 3]);
  });
});
