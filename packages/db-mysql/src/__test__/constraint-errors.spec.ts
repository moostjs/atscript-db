import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { caught, createMockDriver, prepareFixtures } from "./test-utils";

// Since 0.1.165 MySQL constraint errors are normalized by the table layer
// from the key name / `FOREIGN KEY (…)` clause: one entry per logical field,
// a per-entry `code` + `params`, the engine text in `details`. Before, a
// compound unique key reported the index name as the path.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/constraint-errors.as");
});

function failingWith(errno: number, message: string) {
  const err = Object.assign(new Error(message), { errno, sqlMessage: message });
  const driver = createMockDriver({
    runResponder: (sql: string) => {
      if (/^(INSERT|UPDATE|DELETE)/.test(sql)) throw err;
      return {};
    },
  } as any);
  const space = new DbSpace(() => new MysqlAdapter(driver));
  return (type: unknown): any => space.getTable(type as never);
}

describe("[mysql] constraint errors", () => {
  it("compound unique: one UNIQUE entry per field", async () => {
    const t = failingWith(
      1062,
      "Duplicate entry '1-salt' for key 'ce_items.atscript__unique__ce_household_name'",
    );
    const error = await caught(
      t(fx.CeItem).insertOne({ id: 2, householdId: 1, name: "salt", code: "B" }),
    );
    const params = { index: "ce_household_name", fields: ["householdId", "name"] };
    expect(error.errors).toEqual([
      expect.objectContaining({ path: "householdId", code: "UNIQUE", params }),
      expect.objectContaining({ path: "name", code: "UNIQUE", params }),
    ]);
  });

  it("PRIMARY: the key's fields", async () => {
    const t = failingWith(1062, "Duplicate entry '1' for key 'ce_items.PRIMARY'");
    const error = await caught(
      t(fx.CeItem).insertOne({ id: 1, householdId: 1, name: "x", code: "Z" }),
    );
    expect(error.errors).toEqual([
      expect.objectContaining({ path: "id", params: { index: "primaryKey", fields: ["id"] } }),
    ]);
  });

  it("FK on write (1452): the failing key, its target", async () => {
    const t = failingWith(
      1452,
      "Cannot add or update a child row: a foreign key constraint fails (`db`.`ce_items`, CONSTRAINT `ce_items_ibfk_2` FOREIGN KEY (`ownerId`) REFERENCES `ce_people` (`id`))",
    );
    const error = await caught(
      t(fx.CeItem).insertOne({ id: 2, householdId: 1, name: "x", code: "Z", ownerId: 99 }),
    );
    expect(error.errors).toEqual([
      expect.objectContaining({
        path: "ownerId",
        code: "FK_MISSING",
        params: { fields: ["ownerId"], target: "ce_people" },
      }),
    ]);
  });

  it("FK on delete (1451): FK_RESTRICT naming the referencing table", async () => {
    const t = failingWith(
      1451,
      "Cannot delete or update a parent row: a foreign key constraint fails (`db`.`ce_items`, CONSTRAINT `ce_items_ibfk_1` FOREIGN KEY (`householdId`) REFERENCES `ce_households` (`id`))",
    );
    const error = await caught(t(fx.CeHousehold).deleteOne(1));
    expect(error.code).toBe("CONFLICT");
    expect(error.errors).toEqual([
      expect.objectContaining({
        path: "ce_households",
        code: "FK_RESTRICT",
        params: { table: "ce_households", referencedBy: "ce_items" },
      }),
    ]);
  });
});
