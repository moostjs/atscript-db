import { DbError } from "@atscript/db";
import type { AtscriptDbTable, DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures, user } from "./test-utils";

// Populated after fixtures compile.
let User: any;
let Composite: any;

describe("MemoryAdapter stored mode (driven through AtscriptDbTable)", () => {
  let space: DbSpace;
  let users: AtscriptDbTable;
  let composites: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/stored.as");
    User = fixtures.User;
    Composite = fixtures.Composite;
  });

  // Fresh space (⇒ fresh adapter ⇒ empty store) per test for isolation.
  beforeEach(async () => {
    space = createTestSpace();
    users = space.getTable(User);
    composites = space.getTable(Composite);
    await bootstrapStoredTables(space, [User, Composite]);
  });

  // WHY: the baseline path — a row inserted through the table must be findable
  // by id and appear in a full scan, proving storage+read wire end-to-end.
  it("inserts a row and reads it back by id and via findMany", async () => {
    await users.insertOne(user({ id: "u1", name: "Ada", age: 30 }));

    const byId = (await users.findOne({ filter: { id: "u1" }, controls: {} })) as any;
    expect(byId).toMatchObject({ id: "u1", name: "Ada", age: 30 });

    const all = (await users.findMany({ filter: {}, controls: {} })) as any[];
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("u1");
  });

  // WHY: a unique index must be enforced by the adapter itself (memory has no
  // DB to reject it) — surfaced as CONFLICT with the offending field's path.
  it("rejects a duplicate value on a unique index with CONFLICT on the field", async () => {
    await users.insertOne(user({ id: "u1", email: "dup@x.com" }));
    let err: DbError | undefined;
    try {
      await users.insertOne(user({ id: "u2", email: "dup@x.com" }));
    } catch (e) {
      err = e as DbError;
    }
    expect(err).toBeInstanceOf(DbError);
    expect(err!.code).toBe("CONFLICT");
    expect(err!.errors[0]!.path).toBe("email");
  });

  // WHY: primary-key uniqueness is the store's core invariant; a second insert
  // of the same id must fail (the sync lock relies on this throwing).
  it("rejects a duplicate primary key with CONFLICT", async () => {
    await users.insertOne(user({ id: "u1" }));
    let err: DbError | undefined;
    try {
      await users.insertOne(user({ id: "u1", email: "other@x.com" }));
    } catch (e) {
      err = e as DbError;
    }
    expect(err).toBeInstanceOf(DbError);
    expect(err!.code).toBe("CONFLICT");
  });

  // WHY: inclusion projection returns only the chosen paths PLUS the pk (Mongo
  // parity), and must reach into nested objects via a dot-path.
  it("inclusion projection keeps pk + selected paths only (incl. nested)", async () => {
    await users.insertOne(
      user({ id: "u1", name: "Ada", age: 30, profile: { city: "NYC", age: 5 } }),
    );
    const rows = (await users.findMany({
      filter: {},
      controls: { $select: { name: 1, "profile.city": 1 } },
    })) as any[];
    const row = rows[0];
    // pk auto-included, name selected, profile narrowed to just city.
    expect(row).toEqual({ id: "u1", name: "Ada", profile: { city: "NYC" } });
    expect(row.age).toBeUndefined();
    expect(row.email).toBeUndefined();
  });

  // WHY: exclusion projection returns everything EXCEPT the named path.
  it("exclusion projection removes the named field", async () => {
    await users.insertOne(user({ id: "u1", name: "Ada", age: 30 }));
    const rows = (await users.findMany({
      filter: {},
      controls: { $select: { age: 0 } },
    })) as any[];
    const row = rows[0];
    expect(row.age).toBeUndefined();
    expect(row).toMatchObject({ id: "u1", name: "Ada" });
  });

  // WHY: sorting must be a deterministic total order; null/absent values sort
  // LOW (ascending puts them first), independent of direction otherwise.
  it("sorts ascending and descending with null/absent sorting LOW", async () => {
    await users.insertOne(user({ id: "a", nickname: "Bob" }));
    await users.insertOne(user({ id: "b" })); // no nickname → absent
    await users.insertOne(user({ id: "c", nickname: "Amy" }));

    const asc = (await users.findMany({
      filter: {},
      controls: { $sort: { nickname: 1 } },
    })) as any[];
    expect(asc.map((r) => r.id)).toEqual(["b", "c", "a"]); // absent, Amy, Bob

    const desc = (await users.findMany({
      filter: {},
      controls: { $sort: { nickname: -1 } },
    })) as any[];
    expect(desc.map((r) => r.id)).toEqual(["a", "c", "b"]); // Bob, Amy, absent-last
  });

  // WHY: pagination applies $skip then $limit after sorting.
  it("paginates with $skip and $limit over a sorted result", async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      await users.insertOne(user({ id: `u${n}`, age: n * 10 }));
    }
    const page = (await users.findMany({
      filter: {},
      controls: { $sort: { age: 1 }, $skip: 1, $limit: 2 },
    })) as any[];
    expect(page.map((r) => r.age)).toEqual([20, 30]);
  });

  // WHY: count reflects the FILTER only — sort/skip/limit are irrelevant to it.
  it("count reflects the filter only, ignoring pagination controls", async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      await users.insertOne(user({ id: `u${n}`, age: n * 10 }));
    }
    const total = await users.count({
      filter: { age: { $gte: 30 } },
      controls: { $skip: 1, $limit: 1 },
    });
    expect(total).toBe(3); // ages 30,40,50
  });

  // WHY: findManyWithCount returns the full filtered total alongside just the
  // requested page — from a single snapshot.
  it("findManyWithCount: count = full filtered total, data = the page", async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      await users.insertOne(user({ id: `u${n}`, age: n * 10 }));
    }
    const { data, count } = await users.findManyWithCount({
      filter: { age: { $gte: 20 } },
      controls: { $sort: { age: 1 }, $limit: 2 },
    });
    expect(count).toBe(4); // ages 20,30,40,50 match
    expect((data as any[]).map((r) => r.age)).toEqual([20, 30]);
  });

  // WHY: the store must be immune to caller mutation on BOTH sides —
  // mutating a returned row, and mutating the payload after insert.
  it("clones on output and on input so the store cannot be aliased", async () => {
    const payload = user({ id: "u1", name: "Ada", profile: { city: "NYC", age: 5 } });
    await users.insertOne(payload);

    // Mutate the caller's payload (incl. nested) AFTER insert — store unaffected.
    payload.name = "MUT";
    payload.profile.city = "MUT";
    const afterInputMutation = (await users.findOne({ filter: { id: "u1" }, controls: {} })) as any;
    expect(afterInputMutation.name).toBe("Ada");
    expect(afterInputMutation.profile.city).toBe("NYC");

    // Mutate a returned row (incl. nested) — a later read is unaffected.
    const first = (await users.findMany({ filter: {}, controls: {} })) as any[];
    first[0].name = "MUT";
    first[0].profile.city = "MUT";
    const second = (await users.findMany({ filter: {}, controls: {} })) as any[];
    expect(second[0].name).toBe("Ada");
    expect(second[0].profile.city).toBe("NYC");
  });

  // WHY: version is server-managed (no DDL DEFAULT in memory) — the adapter
  // fills 0 at insert when the caller omits it.
  it("defaults the version column to 0 on insert", async () => {
    await users.insertOne(user({ id: "u1" }));
    const row = (await users.findOne({ filter: { id: "u1" }, controls: {} })) as any;
    expect(row.version).toBe(0);
  });

  // WHY: composite keys must be encoded collision-proof — a naive string concat
  // ("a"+"b:c" === "a:b"+"c") would merge these into one row; JSON encoding
  // keeps them distinct.
  it("stores composite-key rows that would collide under naive concat as distinct", async () => {
    await composites.insertOne({ part1: "a", part2: "b:c", label: "first" } as any);
    await composites.insertOne({ part1: "a:b", part2: "c", label: "second" } as any);

    const all = (await composites.findMany({ filter: {}, controls: {} })) as any[];
    expect(all).toHaveLength(2);

    const first = (await composites.findOne({
      filter: { part1: "a", part2: "b:c" },
      controls: {},
    })) as any;
    const second = (await composites.findOne({
      filter: { part1: "a:b", part2: "c" },
      controls: {},
    })) as any;
    expect(first.label).toBe("first");
    expect(second.label).toBe("second");
  });

  // WHY: a COMPOSITE-PK table has no single `@meta.id`, so `metaIdPhysical` is
  // null and the base `_resolveInsertedId` would fall back to `undefined` —
  // leaving `POST /db/<table>` without a usable `insertedId` (the as-test
  // db-ops parity gap). The adapter must instead return a DEFINED id built from
  // the primary-key field values.
  it("insertOne on a composite-PK table returns a DEFINED insertedId = the pk object", async () => {
    const res = await composites.insertOne({ part1: "a", part2: "b", label: "x" } as any);
    expect(res.insertedId).toBeDefined();
    expect(res.insertedId).toEqual({ part1: "a", part2: "b" });
  });

  // WHY: insertMany must hand back a DEFINED composite id per row, carrying the
  // correct pk values in insertedIds order (not `undefined` placeholders).
  it("insertMany on a composite-PK table returns DEFINED composite insertedIds in order", async () => {
    const res = await composites.insertMany([
      { part1: "a", part2: "1", label: "first" },
      { part1: "b", part2: "2", label: "second" },
    ] as any);
    expect(res.insertedCount).toBe(2);
    for (const id of res.insertedIds) {
      expect(id).toBeDefined();
    }
    expect(res.insertedIds).toEqual([
      { part1: "a", part2: "1" },
      { part1: "b", part2: "2" },
    ]);
  });

  // WHY: the composite-id fallback must NOT alter single-`@meta.id` tables —
  // their insertedId stays the scalar user-supplied pk value, unchanged.
  it("insertOne on a single-@meta.id table still returns the scalar id", async () => {
    const res = await users.insertOne(user({ id: "u1", name: "Ada" }));
    expect(res.insertedId).toBe("u1");
  });
});
