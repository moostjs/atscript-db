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
