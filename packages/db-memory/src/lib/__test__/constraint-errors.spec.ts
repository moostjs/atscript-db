import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, caught, createTestSpace, prepareFixtures } from "./test-utils";

// Since 0.1.165 the memory adapter's unique / primary-key conflicts and the
// application-level FK / RESTRICT checks produce the normalized entries every
// adapter shares: one per logical field, `code` + `params`. Before, a
// compound unique key reported its first field only, and a composite FK one
// entry whose path joined the fields ("slotA, slotB").

let fx: Record<string, any>;
let t: (type: unknown) => any;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/constraint-errors.as");
});

beforeEach(async () => {
  const space = createTestSpace();
  await bootstrapStoredTables(space, [
    fx.CeHousehold,
    fx.CePerson,
    fx.CeItem,
    fx.CeSlot,
    fx.CeReservation,
  ]);
  t = (type) => space.getTable(type as never);
  await t(fx.CeHousehold).insertOne({ id: 1, name: "h" });
  await t(fx.CeItem).insertOne({ id: 1, householdId: 1, name: "salt", code: "A" });
  await t(fx.CeSlot).insertOne({ id: 1, a: 1, b: 1 });
});

describe("[memory] constraint errors", () => {
  it("compound unique: one UNIQUE entry per field", async () => {
    const error = await caught(
      t(fx.CeItem).insertOne({ id: 2, householdId: 1, name: "salt", code: "B" }),
    );
    const params = { index: "ce_household_name", fields: ["householdId", "name"] };
    expect(error.errors).toEqual([
      expect.objectContaining({ path: "householdId", code: "UNIQUE", params }),
      expect.objectContaining({ path: "name", code: "UNIQUE", params }),
    ]);
  });

  it("primary key: a UNIQUE entry on the key", async () => {
    const error = await caught(
      t(fx.CeItem).insertOne({ id: 1, householdId: 1, name: "x", code: "Z" }),
    );
    expect(error.errors).toEqual([
      expect.objectContaining({ path: "id", params: { index: "primaryKey", fields: ["id"] } }),
    ]);
  });

  it("composite FK: one FK_MISSING entry per field", async () => {
    const error = await caught(t(fx.CeReservation).insertOne({ id: 1, slotA: 1, slotB: 9 }));
    expect(error.code).toBe("FK_VIOLATION");
    const params = { fields: ["slotA", "slotB"], target: "ce_slots" };
    expect(error.errors).toEqual([
      expect.objectContaining({ path: "slotA", code: "FK_MISSING", params }),
      expect.objectContaining({ path: "slotB", code: "FK_MISSING", params }),
    ]);
  });

  it("RESTRICT: an FK_RESTRICT entry naming the referencing table and fields", async () => {
    const error = await caught(t(fx.CeHousehold).deleteOne(1));
    expect(error.code).toBe("CONFLICT");
    expect(error.errors).toEqual([
      expect.objectContaining({
        path: "ce_households",
        code: "FK_RESTRICT",
        params: { table: "ce_households", referencedBy: "ce_items", fields: ["householdId"] },
      }),
    ]);
  });
});

describe("[memory] validateRows fk lookup — composite key", () => {
  it("reports only the rows whose composite key has no target", async () => {
    const errors = await t(fx.CeReservation).validateRows(
      [
        { id: 1, slotA: 1, slotB: 1 },
        { id: 2, slotA: 1, slotB: 2 },
      ],
      "insert",
      { fk: true },
    );
    expect(errors.map((e: any) => [e.index, e.path])).toEqual([
      [1, "slotA"],
      [1, "slotB"],
    ]);
  });
});
