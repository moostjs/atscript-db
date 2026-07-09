import { DbError } from "@atscript/db";
import type { AtscriptDbTable, BaseDbAdapter, DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures, user } from "./test-utils";

// Populated after fixtures compile.
let User: any;
let Composite: any;

describe("MemoryAdapter stored mode — mutations (update / replace / delete + OCC)", () => {
  let space: DbSpace;
  let users: AtscriptDbTable;
  let composites: AtscriptDbTable;
  // Direct adapter handles: mutations at the ADAPTER contract level (CAS,
  // field-ops, replace semantics) are exercised here, bypassing the table's
  // patch decomposition. `getTable(t).dbAdapter === getAdapter(t)`, so these
  // read/write the SAME store the tables populate.
  let usersAdapter: BaseDbAdapter;
  let compositesAdapter: BaseDbAdapter;

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
    usersAdapter = space.getAdapter(User);
    compositesAdapter = space.getAdapter(Composite);
    await bootstrapStoredTables(space, [User, Composite]);
  });

  /** Reads a stored User row directly from the adapter (physical shape). */
  async function readUser(id: string): Promise<any> {
    return usersAdapter.findOne({ filter: { id }, controls: {} });
  }

  // WHY: the core update contract — $set overwrites the named fields, reports
  // matched===modified===1, and (versioned) each successful update bumps the
  // version monotonically 0 → 1 → 2.
  it("updateOne: $set changes fields, matched===modified===1, version bumps 0→1→2", async () => {
    await users.insertOne(user({ id: "u1", name: "Ada", age: 30 }));
    expect((await readUser("u1")).version).toBe(0);

    const r1 = await usersAdapter.updateOne({ id: { $eq: "u1" } }, { name: "Bob" });
    expect(r1).toEqual({ matchedCount: 1, modifiedCount: 1 });
    let row = await readUser("u1");
    expect(row.name).toBe("Bob");
    expect(row.age).toBe(30); // untouched
    expect(row.version).toBe(1);

    const r2 = await usersAdapter.updateOne({ id: { $eq: "u1" } }, { name: "Cy" });
    expect(r2).toEqual({ matchedCount: 1, modifiedCount: 1 });
    row = await readUser("u1");
    expect(row.name).toBe("Cy");
    expect(row.version).toBe(2);
  });

  // WHY: a filter that matches nothing is a no-op, not an error — reports
  // matched===modified===0 and leaves the store untouched.
  it("updateOne: no match → { matchedCount: 0, modifiedCount: 0 }", async () => {
    await users.insertOne(user({ id: "u1" }));
    const r = await usersAdapter.updateOne({ id: { $eq: "nope" } }, { name: "X" });
    expect(r).toEqual({ matchedCount: 0, modifiedCount: 0 });
    expect((await readUser("u1")).name).toBe("N");
  });

  // WHY: field ops — inc adds (a NEGATIVE inc is how $dec arrives, pre-normalized
  // upstream), mul multiplies; the version bump stays exactly +1 and is NOT
  // affected by the inc/mul on a different field.
  it("field-ops: inc adds, negative inc subtracts, mul multiplies; version still +1", async () => {
    await users.insertOne(user({ id: "u1", age: 10 }));

    await usersAdapter.updateOne({ id: { $eq: "u1" } }, {}, { inc: { age: 5 } });
    let row = await readUser("u1");
    expect(row.age).toBe(15);
    expect(row.version).toBe(1);

    // Negative inc == $dec (normalized to negative inc upstream).
    await usersAdapter.updateOne({ id: { $eq: "u1" } }, {}, { inc: { age: -3 } });
    row = await readUser("u1");
    expect(row.age).toBe(12);
    expect(row.version).toBe(2);

    await usersAdapter.updateOne({ id: { $eq: "u1" } }, {}, { mul: { age: 2 } });
    row = await readUser("u1");
    expect(row.age).toBe(24);
    expect(row.version).toBe(3); // exactly +1 each time, never affected by the age op
  });

  // WHY: OCC — a matching expectedVersion applies the update and bumps.
  it("OCC: matching expectedVersion applies the update and bumps the version", async () => {
    await users.insertOne(user({ id: "u1", name: "Ada" }));
    const r = await usersAdapter.updateOne({ id: { $eq: "u1" } }, { name: "Bob" }, undefined, 0);
    expect(r).toEqual({ matchedCount: 1, modifiedCount: 1 });
    const row = await readUser("u1");
    expect(row.name).toBe("Bob");
    expect(row.version).toBe(1);
  });

  // WHY: OCC — a STALE expectedVersion must NOT throw; it yields zero matches and
  // leaves the stored row completely unchanged.
  it("OCC: stale expectedVersion → { matchedCount: 0 }, no throw, row unchanged", async () => {
    await users.insertOne(user({ id: "u1", name: "Ada" }));
    // Advance the version to 1.
    await usersAdapter.updateOne({ id: { $eq: "u1" } }, { name: "Bob" }, undefined, 0);

    // Now expect version 0 — stale.
    const r = await usersAdapter.updateOne({ id: { $eq: "u1" } }, { name: "Zzz" }, undefined, 0);
    expect(r).toEqual({ matchedCount: 0, modifiedCount: 0 });
    const row = await readUser("u1");
    expect(row.name).toBe("Bob"); // unchanged
    expect(row.version).toBe(1); // not re-bumped
  });

  // WHY: OCC is a versioned-table feature — asking for it on a non-versioned
  // table (Composite has no @db.column.version) is a misconfiguration and throws.
  it("OCC: expectedVersion on a non-versioned table throws", async () => {
    await composites.insertOne({ part1: "a", part2: "b", label: "x" } as any);
    await expect(
      compositesAdapter.updateOne({ part1: { $eq: "a" } }, { label: "y" }, undefined, 0),
    ).rejects.toThrow("expectedVersion requires a versioned table");
  });

  // WHY: updateMany applies to every match, bumps each row's version, and takes
  // NO expectedVersion (never CAS-checks).
  it("updateMany: applies to all matches and bumps each version", async () => {
    await users.insertOne(user({ id: "u1", age: 20 }));
    await users.insertOne(user({ id: "u2", age: 20 }));
    await users.insertOne(user({ id: "u3", age: 99 })); // not matched

    const r = await usersAdapter.updateMany({ age: { $eq: 20 } }, { name: "grp" });
    expect(r).toEqual({ matchedCount: 2, modifiedCount: 2 });

    expect((await readUser("u1")).name).toBe("grp");
    expect((await readUser("u1")).version).toBe(1);
    expect((await readUser("u2")).name).toBe("grp");
    expect((await readUser("u2")).version).toBe(1);
    // Untouched row keeps its original name + version.
    expect((await readUser("u3")).name).toBe("N");
    expect((await readUser("u3")).version).toBe(0);
  });

  // WHY: replaceOne is a FULL-document replace — fields absent from the payload
  // are dropped, and the version is derived as old + 1.
  it("replaceOne: drops fields absent from data and sets version = old + 1", async () => {
    await users.insertOne(user({ id: "u1", name: "Ada", age: 30, nickname: "nick" }));
    expect((await readUser("u1")).nickname).toBe("nick");

    const r = await usersAdapter.replaceOne(
      { id: { $eq: "u1" } },
      { id: "u1", name: "New", email: "u1@x.com", age: 99 },
    );
    expect(r).toEqual({ matchedCount: 1, modifiedCount: 1 });

    const row = await readUser("u1");
    expect(row.name).toBe("New");
    expect(row.age).toBe(99);
    expect(row.nickname).toBeUndefined(); // dropped by full replace
    expect(row.version).toBe(1); // old (0) + 1
  });

  // WHY: replaceOne honours OCC too — a stale expectedVersion is a zero-match
  // no-op, not a throw, and leaves the row untouched.
  it("replaceOne: stale expectedVersion → { matchedCount: 0 }", async () => {
    await users.insertOne(user({ id: "u1", name: "Ada" }));
    await usersAdapter.replaceOne(
      { id: { $eq: "u1" } },
      { id: "u1", name: "V1", email: "u1@x.com", age: 1 },
    ); // version → 1

    const r = await usersAdapter.replaceOne(
      { id: { $eq: "u1" } },
      { id: "u1", name: "V2", email: "u1@x.com", age: 2 },
      0, // stale
    );
    expect(r).toEqual({ matchedCount: 0, modifiedCount: 0 });
    const row = await readUser("u1");
    expect(row.name).toBe("V1"); // unchanged
    expect(row.version).toBe(1);
  });

  // WHY: replaceMany is deliberately a $set MERGE (not a full replace) + version
  // bump on every match — a field NOT in `data` must be RETAINED, proving the
  // merge-not-replace semantics (mirrors Mongo's replaceMany).
  it("replaceMany: MERGES across matches (retains absent fields) and bumps version", async () => {
    await users.insertOne(user({ id: "u1", name: "Ada", age: 30, nickname: "keepA" }));
    await users.insertOne(user({ id: "u2", name: "Bea", age: 30, nickname: "keepB" }));

    const r = await usersAdapter.replaceMany({ age: { $eq: 30 } }, { name: "merged" });
    expect(r).toEqual({ matchedCount: 2, modifiedCount: 2 });

    const u1 = await readUser("u1");
    expect(u1.name).toBe("merged");
    expect(u1.nickname).toBe("keepA"); // NOT in data → retained (merge, not replace)
    expect(u1.age).toBe(30);
    expect(u1.version).toBe(1);

    const u2 = await readUser("u2");
    expect(u2.name).toBe("merged");
    expect(u2.nickname).toBe("keepB");
    expect(u2.version).toBe(1);
  });

  // WHY: a unique index is enforced by the adapter on UPDATE too — moving a row's
  // email onto another row's email is a CONFLICT with the field's path.
  it("update to a colliding unique value throws CONFLICT on the field", async () => {
    await users.insertOne(user({ id: "u1", email: "a@x.com" }));
    await users.insertOne(user({ id: "u2", email: "b@x.com" }));

    let err: DbError | undefined;
    try {
      await usersAdapter.updateOne({ id: { $eq: "u2" } }, { email: "a@x.com" });
    } catch (e) {
      err = e as DbError;
    }
    expect(err).toBeInstanceOf(DbError);
    expect(err!.code).toBe("CONFLICT");
    expect(err!.errors[0]!.path).toBe("email");
    // u2 must be untouched by the failed update (atomic-on-throw).
    expect((await readUser("u2")).email).toBe("b@x.com");
    expect((await readUser("u2")).version).toBe(0);
  });

  // WHY: a row KEEPING (re-writing) its own unique value must NOT self-conflict —
  // the excludeKey path skips the row under its own storage key.
  it("update keeping the row's own unique value succeeds (excludeKey works)", async () => {
    await users.insertOne(user({ id: "u1", name: "Ada", email: "a@x.com" }));

    const r = await usersAdapter.updateOne(
      { id: { $eq: "u1" } },
      { name: "renamed", email: "a@x.com" }, // same email
    );
    expect(r).toEqual({ matchedCount: 1, modifiedCount: 1 });
    const row = await readUser("u1");
    expect(row.name).toBe("renamed");
    expect(row.email).toBe("a@x.com");
    expect(row.version).toBe(1);
  });

  // WHY: deleteOne removes exactly one matched row (and 0 when nothing matches);
  // a deleted row is gone on re-read.
  it("deleteOne: removes one match, returns { deletedCount: 1 } (0 when no match)", async () => {
    await users.insertOne(user({ id: "u1" }));
    await users.insertOne(user({ id: "u2" }));

    const r = await usersAdapter.deleteOne({ id: { $eq: "u1" } });
    expect(r).toEqual({ deletedCount: 1 });
    expect(await readUser("u1")).toBeNull(); // gone
    expect(await readUser("u2")).not.toBeNull(); // untouched
    expect(await usersAdapter.count({ filter: {}, controls: {} })).toBe(1);

    const miss = await usersAdapter.deleteOne({ id: { $eq: "u1" } });
    expect(miss).toEqual({ deletedCount: 0 });
  });

  // WHY: deleteMany removes ALL matches with the correct count; non-matches stay.
  it("deleteMany: removes all matches with the right count", async () => {
    await users.insertOne(user({ id: "u1", age: 20 }));
    await users.insertOne(user({ id: "u2", age: 20 }));
    await users.insertOne(user({ id: "u3", age: 99 }));

    const r = await usersAdapter.deleteMany({ age: { $eq: 20 } });
    expect(r).toEqual({ deletedCount: 2 });
    expect(await readUser("u1")).toBeNull();
    expect(await readUser("u2")).toBeNull();
    expect(await readUser("u3")).not.toBeNull();
    expect(await usersAdapter.count({ filter: {}, controls: {} })).toBe(1);
  });

  // ── Table-level integration (the real consumer patch/$cas/delete path) ──────

  // WHY: a patch driven through AtscriptDbTable.updateOne wires end-to-end:
  // decompose → separateFieldOps → adapter.updateOne, bumping the version.
  it("table.updateOne: patches a row through the real consumer path", async () => {
    await users.insertOne(user({ id: "u1", name: "Ada", age: 30 }));

    const r = await users.updateOne({ id: "u1", name: "Bob" });
    expect(r.matchedCount).toBe(1);
    const row = (await users.findOne({ filter: { id: "u1" }, controls: {} })) as any;
    expect(row.name).toBe("Bob");
    expect(row.age).toBe(30); // patch left it alone
    expect(row.version).toBe(1);
  });

  // WHY: a NESTED merge-strategy patch driven through the table decomposes into a
  // DOT-PATH key ("profile.city") because the adapter reports no native patch —
  // the adapter must nest it into the stored document (merging siblings), NOT
  // create a literal "profile.city" key. Proves the dot-path $set fix end-to-end.
  it("table.updateOne: a nested merge patch nests into the doc and retains siblings", async () => {
    await users.insertOne(
      user({ id: "u1", name: "Ada", age: 30, profile: { city: "NYC", age: 5 } }),
    );

    const r = await users.updateOne({ id: "u1", profile: { city: "LA" } } as any);
    expect(r.matchedCount).toBe(1);

    const row = await readUser("u1");
    expect(row.profile.city).toBe("LA"); // nested path updated
    expect(row.profile.age).toBe(5); // sibling left untouched (merge)
    expect(row["profile.city"]).toBeUndefined(); // NO literal dotted key created
    expect(row.version).toBe(1);
  });

  // WHY: the table's inline `$cas` marker drives OCC through separateCas →
  // adapter expectedVersion — a matching version applies, a stale one is a
  // zero-match no-op (never a throw).
  it("table.updateOne with $cas: matching version applies, stale version is a no-op", async () => {
    await users.insertOne(user({ id: "u1", name: "Ada" }));

    const ok = await users.updateOne({ id: "u1", name: "Bob", $cas: { version: 0 } } as any);
    expect(ok.matchedCount).toBe(1);
    expect(((await users.findOne({ filter: { id: "u1" }, controls: {} })) as any).version).toBe(1);

    // version is now 1 — a $cas of 0 is stale.
    const stale = await users.updateOne({ id: "u1", name: "Zzz", $cas: { version: 0 } } as any);
    expect(stale.matchedCount).toBe(0);
    const row = (await users.findOne({ filter: { id: "u1" }, controls: {} })) as any;
    expect(row.name).toBe("Bob"); // unchanged
    expect(row.version).toBe(1);
  });

  // WHY: AtscriptDbTable.deleteOne by id resolves the pk filter and removes the
  // row from the store.
  it("table.deleteOne: removes the row by id", async () => {
    await users.insertOne(user({ id: "u1" }));
    const r = await users.deleteOne("u1");
    expect(r.deletedCount).toBe(1);
    expect(await users.findOne({ filter: { id: "u1" }, controls: {} })).toBeNull();
  });
});
