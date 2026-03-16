import { describe, it, expect } from "vite-plus/test";
import { computeForeignKeyDiff, hasForeignKeyChanges } from "../schema/fk-diff";
import type { TDbForeignKey } from "../types";
import type { TForeignKeySnapshot } from "../schema/schema-hash";

function fk(
  fields: string[],
  targetTable: string,
  targetFields: string[],
  onDelete?: string,
  onUpdate?: string,
): TDbForeignKey {
  return {
    fields,
    targetTable,
    targetFields,
    onDelete: onDelete as TDbForeignKey["onDelete"],
    onUpdate: onUpdate as TDbForeignKey["onUpdate"],
  };
}

function snap(
  fields: string[],
  targetTable: string,
  targetFields: string[],
  onDelete?: string,
  onUpdate?: string,
): TForeignKeySnapshot {
  return { fields, targetTable, targetFields, onDelete, onUpdate };
}

function mapFromFks(...fks: TDbForeignKey[]): ReadonlyMap<string, TDbForeignKey> {
  const m = new Map<string, TDbForeignKey>();
  for (const f of fks) {
    m.set(f.fields.join("_"), f);
  }
  return m;
}

describe("computeForeignKeyDiff", () => {
  it("returns empty diff when FKs are identical", () => {
    const desired = mapFromFks(fk(["parentId"], "parents", ["id"], "cascade"));
    const existing = [snap(["parentId"], "parents", ["id"], "cascade")];
    const diff = computeForeignKeyDiff(desired, existing);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(hasForeignKeyChanges(diff)).toBe(false);
  });

  it("detects added FK", () => {
    const desired = mapFromFks(fk(["parentId"], "parents", ["id"]));
    const diff = computeForeignKeyDiff(desired, []);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].targetTable).toBe("parents");
    expect(hasForeignKeyChanges(diff)).toBe(true);
  });

  it("detects removed FK", () => {
    const desired = mapFromFks();
    const existing = [snap(["parentId"], "parents", ["id"])];
    const diff = computeForeignKeyDiff(desired, existing);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].targetTable).toBe("parents");
    expect(hasForeignKeyChanges(diff)).toBe(true);
  });

  it("detects target table change", () => {
    const desired = mapFromFks(fk(["groupId"], "teams", ["id"]));
    const existing = [snap(["groupId"], "departments", ["id"])];
    const diff = computeForeignKeyDiff(desired, existing);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].existing.targetTable).toBe("departments");
    expect(diff.changed[0].desired.targetTable).toBe("teams");
  });

  it("detects target fields change", () => {
    const desired = mapFromFks(fk(["userId"], "users", ["email"]));
    const existing = [snap(["userId"], "users", ["id"])];
    const diff = computeForeignKeyDiff(desired, existing);
    expect(diff.changed).toHaveLength(1);
  });

  it("detects onDelete change", () => {
    const desired = mapFromFks(fk(["sponsorId"], "parents", ["id"], "restrict"));
    const existing = [snap(["sponsorId"], "parents", ["id"], "setNull")];
    const diff = computeForeignKeyDiff(desired, existing);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].existing.onDelete).toBe("setNull");
    expect(diff.changed[0].desired.onDelete).toBe("restrict");
  });

  it("detects onUpdate change", () => {
    const desired = mapFromFks(fk(["parentId"], "parents", ["id"], undefined, "cascade"));
    const existing = [snap(["parentId"], "parents", ["id"], undefined, "restrict")];
    const diff = computeForeignKeyDiff(desired, existing);
    expect(diff.changed).toHaveLength(1);
  });

  it("handles multiple changes (add + remove + change)", () => {
    const desired = mapFromFks(
      fk(["newFk"], "other", ["id"]),
      fk(["kept"], "target", ["id"], "restrict"),
    );
    const existing = [
      snap(["oldFk"], "old_table", ["id"]),
      snap(["kept"], "target", ["id"], "cascade"),
    ];
    const diff = computeForeignKeyDiff(desired, existing);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].fields).toEqual(["newFk"]);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].fields).toEqual(["oldFk"]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].desired.onDelete).toBe("restrict");
  });

  it("returns empty diff for empty inputs", () => {
    const diff = computeForeignKeyDiff(new Map(), []);
    expect(hasForeignKeyChanges(diff)).toBe(false);
  });

  it("matches by sorted field names for composite FKs", () => {
    const desired = mapFromFks(fk(["b", "a"], "target", ["y", "x"]));
    const existing = [snap(["a", "b"], "target", ["x", "y"])];
    const diff = computeForeignKeyDiff(desired, existing);
    expect(hasForeignKeyChanges(diff)).toBe(false);
  });

  it("treats undefined and missing onDelete as equal", () => {
    const desired = mapFromFks(fk(["parentId"], "parents", ["id"]));
    const existing = [snap(["parentId"], "parents", ["id"])];
    const diff = computeForeignKeyDiff(desired, existing);
    expect(hasForeignKeyChanges(diff)).toBe(false);
  });
});
