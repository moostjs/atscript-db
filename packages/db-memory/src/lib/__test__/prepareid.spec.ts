import type { AtscriptDbTable, DbSpace } from "@atscript/db";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { MemoryAdapter } from "../memory-adapter";
import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

// Populated after fixtures compile.
let Sequence: any; // numeric PK (`id: number`, @db.default.increment)
let User: any; //     string PK  (`id: string`)

// Pull the id field's annotated type the exact same way the framework does
// (`this.flatMap.get(field)` in db-readable's by-id filter builders).
const idFieldType = (table: AtscriptDbTable): TAtscriptAnnotatedType => table.flatMap.get("id")!;

// WHY these tests exist: the framework calls `adapter.prepareId(value, fieldType)`
// when building by-id filters, so a URL id like "1" reaches memory as the STRING
// "1". Memory does STRICT JS comparison (like Mongo), so an uncoerced "1" would
// compare `"1" === 1` against a numeric PK and never match — every by-id
// fetch/patch/delete/replace of a numeric-PK row would 404. `prepareId` must
// coerce the id to the field's leaf type. This pins that coercion (unit + the
// consumer `findById` path) against the Mongo parity model.
describe("MemoryAdapter.prepareId (type coercion for by-id filters)", () => {
  let space: DbSpace;
  let sequences: AtscriptDbTable;
  let users: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/stored.as");
    Sequence = fixtures.Sequence;
    User = fixtures.User;
  });

  beforeEach(async () => {
    space = createTestSpace();
    sequences = space.getTable(Sequence);
    users = space.getTable(User);
    await bootstrapStoredTables(space, [Sequence, User]);
  });

  it("coerces a STRING id to a number for a numeric PK field (why: strict $eq needs the field type)", () => {
    const adapter = sequences.getAdapter() as MemoryAdapter;
    const ft = idFieldType(sequences);
    const out = adapter.prepareId("21", ft);
    expect(out).toBe(21);
    expect(typeof out).toBe("number");
    // A value already of the right type is preserved.
    expect(adapter.prepareId(21, ft)).toBe(21);
  });

  it("coerces a NUMBER id to a string for a string PK field (why: parity with Mongo's non-objectId branch)", () => {
    const adapter = users.getAdapter() as MemoryAdapter;
    const ft = idFieldType(users);
    const out = adapter.prepareId(21, ft);
    expect(out).toBe("21");
    expect(typeof out).toBe("string");
    expect(adapter.prepareId("21", ft)).toBe("21");
  });

  // End-to-end through the consumer by-id path: insert (increment ⇒ numeric id
  // 1), then look it up with a STRING id — coercion inside prepareId must make
  // the strict store comparison match.
  it("findById with a STRING id finds a numeric-PK row (why: end-to-end coercion via readable)", async () => {
    const res = await sequences.insertOne({ label: "a" });
    expect(res.insertedId).toBe(1); // increment id is a real number

    const byString = (await sequences.findById("1")) as any;
    expect(byString).toMatchObject({ id: 1, label: "a" });

    // And a numeric id still resolves the same row.
    const byNumber = (await sequences.findById(1)) as any;
    expect(byNumber).toMatchObject({ id: 1, label: "a" });

    // A non-existent id still misses (guards against "coerce everything to a hit").
    expect(await sequences.findById("999")).toBeNull();
  });
});

// A boolean part of a composite primary key (since 0.1.192): the framework
// hands over a real boolean (the text `true` / `false` of a URL included) and
// `prepareId` must keep it — `String(true)` never equals a stored `true`.
describe("MemoryAdapter — a boolean part of a composite primary key", () => {
  let space: DbSpace;
  let drafts: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
  });

  beforeEach(async () => {
    const { BkDraft } = await import("./fixtures/boolean-key.as");
    space = createTestSpace();
    drafts = space.getTable(BkDraft);
    await bootstrapStoredTables(space, [BkDraft]);
    await drafts.insertMany([
      { id: "a", active: true, title: "live" },
      { id: "a", active: false, title: "draft" },
    ] as never);
  });

  it("keeps the boolean", () => {
    const adapter = drafts.getAdapter() as MemoryAdapter;
    expect(adapter.prepareId(true, drafts.flatMap.get("active")!)).toBe(true);
  });

  it.each([
    [true, "live"],
    [false, "draft"],
    ["true", "live"],
    ["false", "draft"],
  ])("findById with active %j finds the %s row", async (active, title) => {
    expect(await drafts.findById({ id: "a", active } as never)).toMatchObject({ title });
  });

  it("updates and deletes the row by its key", async () => {
    await drafts.updateOne({ id: "a", active: false, title: "edited" } as never);
    expect(await drafts.findById({ id: "a", active: false } as never)).toMatchObject({
      title: "edited",
    });
    expect((await drafts.deleteOne({ id: "a", active: true } as never)).deletedCount).toBe(1);
  });
});

describe("MemoryAdapter — a nullable boolean part of a compound unique index", () => {
  let flags: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
  });

  beforeEach(async () => {
    const { BkFlag } = await import("./fixtures/boolean-key.as");
    const space = createTestSpace();
    flags = space.getTable(BkFlag);
    await bootstrapStoredTables(space, [BkFlag]);
    await flags.insertMany([
      { id: "1", code: "x", flag: true, title: "on" },
      { id: "2", code: "x", flag: false, title: "off" },
    ] as never);
  });

  it.each([
    ["true", "on"],
    ["false", "off"],
    [true, "on"],
  ])("findById with flag %j finds the %s row", async (flag, title) => {
    expect(await flags.findById({ code: "x", flag } as never)).toMatchObject({ title });
  });
});
