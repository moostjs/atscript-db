import type { AtscriptDbTable, DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

// Populated after fixtures compile.
let Sequence: any;
let Ticket: any;

// WHY these tests exist: the in-memory store has no DB sequence, so unlike the
// SQL adapters (DB autoincrement) or Mongo (counter collection) it must
// GENERATE `@db.default.increment` values itself at insert time. Without that,
// an increment-PK insert stores `id: undefined`, returns no real `insertedId`,
// and the row is unfindable — which is exactly the parity gap the as-test
// db-ops suite caught. These tests pin the generated-id contract.
describe("MemoryAdapter @db.default.increment (stored mode)", () => {
  let space: DbSpace;
  let sequences: AtscriptDbTable;
  let tickets: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/stored.as");
    Sequence = fixtures.Sequence;
    Ticket = fixtures.Ticket;
  });

  // Fresh space (⇒ fresh adapter ⇒ empty store AND reset counter) per test.
  beforeEach(async () => {
    space = createTestSpace();
    sequences = space.getTable(Sequence);
    tickets = space.getTable(Ticket);
    await bootstrapStoredTables(space, [Sequence, Ticket]);
  });

  // WHY: the core gap — an insert with no id must get a real generated id (1),
  // and that id must key the store so the row is findable by it.
  it("generates id 1 for the first insert with no id and stores it findable by that id", async () => {
    const res = await sequences.insertOne({ label: "a" });
    expect(res.insertedId).toBe(1);

    const row = (await sequences.findOne({ filter: { id: 1 }, controls: {} })) as any;
    expect(row).toMatchObject({ id: 1, label: "a" });
  });

  // WHY: the counter must advance across separate inserts, not restart at 1.
  it("increments to 2 on the second insert with no id", async () => {
    expect((await sequences.insertOne({ label: "a" })).insertedId).toBe(1);
    expect((await sequences.insertOne({ label: "b" })).insertedId).toBe(2);
  });

  // WHY: insertMany must hand out sequential ids in insertedIds order (a batch
  // shares one advancing counter), continuing from prior single inserts.
  it("assigns sequential ids 3,4,5 across an insertMany of 3 after two prior inserts", async () => {
    await sequences.insertOne({ label: "a" }); // 1
    await sequences.insertOne({ label: "b" }); // 2

    const res = await sequences.insertMany([{ label: "c" }, { label: "d" }, { label: "e" }]);
    expect(res.insertedIds).toEqual([3, 4, 5]);

    const all = (await sequences.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];
    expect(all.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });

  // WHY: an explicit id above the counter must be honored verbatim AND advance
  // the counter, so a later auto id skips past it instead of colliding.
  it("keeps an explicit id (10) and makes the next auto id skip to 11", async () => {
    expect((await sequences.insertOne({ id: 10, label: "x" })).insertedId).toBe(10);
    expect((await sequences.insertOne({ label: "y" })).insertedId).toBe(11);

    const row = (await sequences.findOne({ filter: { id: 10 }, controls: {} })) as any;
    expect(row).toMatchObject({ id: 10, label: "x" });
  });

  // WHY: `@db.default.increment 100` must seed the FIRST generated value at its
  // declared start, proving the `start` arg is threaded to the counter.
  it("respects a non-default start (100) for the first generated value, then 101", async () => {
    expect((await tickets.insertOne({ subject: "s1" })).insertedId).toBe(100);
    expect((await tickets.insertOne({ subject: "s2" })).insertedId).toBe(101);
  });
});
