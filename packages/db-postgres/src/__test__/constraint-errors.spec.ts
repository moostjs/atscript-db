import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { caught, createMockDriver, prepareFixtures } from "./test-utils";

// Since 0.1.165 PostgreSQL constraint errors are normalized by the table layer
// from the constraint name and the `Key (…)` detail: one entry per logical
// field, a per-entry `code` + `params`, the engine text in `details`.
// Before, a compound unique key reported the constraint name as the path and
// an FK failure only its first column.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/constraint-errors.as");
});

function failingWith(pgError: Record<string, unknown>) {
  const driver = createMockDriver({
    runResponder: (sql) => {
      if (/^(INSERT|UPDATE|DELETE)/.test(sql)) {
        throw Object.assign(new Error("pg error"), pgError);
      }
      return {};
    },
  });
  const space = new DbSpace(() => new PostgresAdapter(driver));
  return (type: unknown): any => space.getTable(type as never);
}

describe("[postgres] constraint errors", () => {
  it("compound unique: one UNIQUE entry per field", async () => {
    const t = failingWith({
      code: "23505",
      constraint: "atscript__unique__ce_household_name",
      detail: 'Key ("householdId", name)=(1, salt) already exists.',
    });
    const error = await caught(
      t(fx.CeItem).insertOne({ id: 2, householdId: 1, name: "salt", code: "B" }),
    );
    expect(error.code).toBe("CONFLICT");
    const params = { index: "ce_household_name", fields: ["householdId", "name"] };
    expect(error.errors).toEqual([
      expect.objectContaining({ path: "householdId", code: "UNIQUE", params }),
      expect.objectContaining({ path: "name", code: "UNIQUE", params }),
    ]);
    expect(error.errors[0]!.details).toContain("already exists");
  });

  it("primary key: the key's fields", async () => {
    const t = failingWith({
      code: "23505",
      constraint: "ce_items_pkey",
      detail: "Key (id)=(1) already exists.",
    });
    const error = await caught(
      t(fx.CeItem).insertOne({ id: 1, householdId: 1, name: "x", code: "Z" }),
    );
    expect(error.errors).toEqual([
      expect.objectContaining({ path: "id", params: { index: "primaryKey", fields: ["id"] } }),
    ]);
  });

  it("FK on write: the failing key, its target", async () => {
    const t = failingWith({
      code: "23503",
      constraint: "ce_items_ownerId_fkey",
      detail: 'Key ("ownerId")=(99) is not present in table "ce_people".',
    });
    const error = await caught(
      t(fx.CeItem).insertOne({ id: 2, householdId: 1, name: "x", code: "Z", ownerId: 99 }),
    );
    expect(error.code).toBe("FK_VIOLATION");
    expect(error.errors).toEqual([
      expect.objectContaining({
        path: "ownerId",
        code: "FK_MISSING",
        params: { fields: ["ownerId"], target: "ce_people" },
      }),
    ]);
  });

  it("FK on delete: FK_RESTRICT naming the referencing table", async () => {
    const t = failingWith({
      code: "23503",
      constraint: "ce_items_householdId_fkey",
      detail: 'Key (id)=(1) is still referenced from table "ce_items".',
    });
    const error = await caught(t(fx.CeHousehold).deleteOne(1));
    expect(error.code).toBe("CONFLICT");
    expect(error.errors).toEqual([
      expect.objectContaining({
        path: "ce_households",
        message:
          'Cannot delete from "ce_households": referenced by records in "ce_items" (RESTRICT)',
        code: "FK_RESTRICT",
        params: { table: "ce_households", referencedBy: "ce_items" },
      }),
    ]);
  });

  // Review fix: a parent-key update blocked by referencing rows is FK_RESTRICT
  // (before: every FK of the table as FK_MISSING).
  it("FK on update of a referenced key: FK_RESTRICT, not FK_MISSING", async () => {
    const t = failingWith({
      code: "23503",
      constraint: "ce_items_householdId_fkey",
      detail: 'Key (id)=(1) is still referenced from table "ce_items".',
    });
    const error = await caught(t(fx.CeHousehold).updateOne({ id: 1, name: "x" }));
    expect(error.errors).toEqual([
      expect.objectContaining({
        path: "ce_households",
        message: 'Cannot update "ce_households": referenced by records in "ce_items" (RESTRICT)',
        code: "FK_RESTRICT",
        params: { table: "ce_households", referencedBy: "ce_items" },
      }),
    ]);
  });
});
