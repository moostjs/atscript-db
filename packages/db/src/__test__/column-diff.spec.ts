/* eslint-disable unicorn/consistent-function-scoping */
import { describe, it, expect } from "vite-plus/test";
import { computeColumnDiff } from "../schema/column-diff";
import type { TDbFieldMeta, TExistingColumn } from "../types";

function field(overrides: Partial<TDbFieldMeta> & { physicalName: string }): TDbFieldMeta {
  return {
    path: overrides.physicalName,
    type: {} as any,
    designType: "string",
    optional: false,
    isPrimaryKey: false,
    ignored: false,
    storage: "column",
    ...overrides,
  };
}

function col(
  name: string,
  type = "TEXT",
  notnull = false,
  pk = false,
  dflt_value?: string,
): TExistingColumn {
  return { name, type, notnull, pk, dflt_value };
}

describe("computeColumnDiff", () => {
  it("should detect added columns", () => {
    const desired = [
      field({ physicalName: "id", designType: "number", isPrimaryKey: true }),
      field({ physicalName: "name" }),
      field({ physicalName: "email" }),
    ];
    const existing = [col("id", "INTEGER", false, true), col("name")];
    const diff = computeColumnDiff(desired, existing);

    expect(diff.added.length).toBe(1);
    expect(diff.added[0].physicalName).toBe("email");
    expect(diff.removed.length).toBe(0);
  });

  it("should detect removed columns", () => {
    const desired = [field({ physicalName: "id", isPrimaryKey: true })];
    const existing = [col("id", "INTEGER", false, true), col("old_col")];
    const diff = computeColumnDiff(desired, existing);

    expect(diff.added.length).toBe(0);
    expect(diff.removed.length).toBe(1);
    expect(diff.removed[0].name).toBe("old_col");
  });

  it("should detect type changes with typeMapper", () => {
    const desired = [field({ physicalName: "count", designType: "number" })];
    const existing = [col("count", "TEXT")];
    const typeMapper = (f: TDbFieldMeta) => (f.designType === "number" ? "REAL" : "TEXT");

    const diff = computeColumnDiff(desired, existing, typeMapper);
    expect(diff.typeChanged.length).toBe(1);
    expect(diff.typeChanged[0].field.physicalName).toBe("count");
    expect(diff.typeChanged[0].existingType).toBe("TEXT");
  });

  it("should skip type changes without typeMapper", () => {
    const desired = [field({ physicalName: "count", designType: "number" })];
    const existing = [col("count", "TEXT")];

    const diff = computeColumnDiff(desired, existing);
    expect(diff.typeChanged.length).toBe(0);
  });

  it("should detect type changes with designType-based typeMapper (Path B)", () => {
    // Simulates snapshot-based path: typeMapper returns designType, snapshot stores designType
    const desired = [field({ physicalName: "count", designType: "number" })];
    const existing = [col("count", "string")];
    const typeMapper = (f: TDbFieldMeta) => f.designType;

    const diff = computeColumnDiff(desired, existing, typeMapper);
    expect(diff.typeChanged.length).toBe(1);
    expect(diff.typeChanged[0].field.physicalName).toBe("count");
    expect(diff.typeChanged[0].existingType).toBe("string");
  });

  it("should not detect type change when designTypes match (Path B)", () => {
    const desired = [field({ physicalName: "name", designType: "string" })];
    const existing = [col("name", "string")];
    const typeMapper = (f: TDbFieldMeta) => f.designType;

    const diff = computeColumnDiff(desired, existing, typeMapper);
    expect(diff.typeChanged.length).toBe(0);
  });

  it("should skip type change for union fields when both sides are union (Path B)", () => {
    // Union mapper: returns 'union' for union fields, which matches 'union' in snapshot
    const desired = [field({ physicalName: "value", designType: "union" })];
    const existing = [col("value", "union")];
    const typeMapper = (f: TDbFieldMeta) => (f.designType === "union" ? "union" : f.designType);

    const diff = computeColumnDiff(desired, existing, typeMapper);
    expect(diff.typeChanged.length).toBe(0);
  });

  it("should ignore fields marked as ignored", () => {
    const desired = [
      field({ physicalName: "id", isPrimaryKey: true }),
      field({ physicalName: "temp", ignored: true }),
    ];
    const existing = [col("id", "INTEGER", false, true)];
    const diff = computeColumnDiff(desired, existing);

    expect(diff.added.length).toBe(0);
  });

  it("should handle empty existing columns (new table)", () => {
    const desired = [
      field({ physicalName: "id", isPrimaryKey: true }),
      field({ physicalName: "name" }),
    ];
    const diff = computeColumnDiff(desired, []);

    expect(diff.added.length).toBe(2);
    expect(diff.removed.length).toBe(0);
  });

  it("should handle no changes", () => {
    const desired = [
      field({ physicalName: "id", isPrimaryKey: true }),
      field({ physicalName: "name" }),
    ];
    const existing = [col("id", "INTEGER", true, true), col("name", "TEXT", true)];
    const diff = computeColumnDiff(desired, existing);

    expect(diff.added.length).toBe(0);
    expect(diff.removed.length).toBe(0);
    expect(diff.typeChanged.length).toBe(0);
    expect(diff.nullableChanged.length).toBe(0);
    expect(diff.defaultChanged.length).toBe(0);
  });

  it("should detect nullable→non-nullable change", () => {
    const desired = [field({ physicalName: "description", optional: false })];
    const existing = [col("description", "TEXT", false)]; // notnull=false → was nullable
    const diff = computeColumnDiff(desired, existing);

    expect(diff.nullableChanged.length).toBe(1);
    expect(diff.nullableChanged[0].field.physicalName).toBe("description");
    expect(diff.nullableChanged[0].wasNullable).toBe(true);
  });

  it("should detect non-nullable→nullable change", () => {
    const desired = [field({ physicalName: "priority", optional: true })];
    const existing = [col("priority", "TEXT", true)]; // notnull=true → was non-nullable
    const diff = computeColumnDiff(desired, existing);

    expect(diff.nullableChanged.length).toBe(1);
    expect(diff.nullableChanged[0].field.physicalName).toBe("priority");
    expect(diff.nullableChanged[0].wasNullable).toBe(false);
  });

  it("should not report nullable change when nullable state matches", () => {
    const desired = [
      field({ physicalName: "name", optional: false }),
      field({ physicalName: "bio", optional: true }),
    ];
    const existing = [col("name", "TEXT", true), col("bio", "TEXT", false)];
    const diff = computeColumnDiff(desired, existing);

    expect(diff.nullableChanged.length).toBe(0);
  });

  it("should detect default value change", () => {
    const desired = [
      field({ physicalName: "status", defaultValue: { kind: "value", value: "pending" } }),
    ];
    const existing = [col("status", "TEXT", true, false, "active")];
    const diff = computeColumnDiff(desired, existing);

    expect(diff.defaultChanged.length).toBe(1);
    expect(diff.defaultChanged[0].field.physicalName).toBe("status");
    expect(diff.defaultChanged[0].oldDefault).toBe("active");
    expect(diff.defaultChanged[0].newDefault).toBe("pending");
  });

  it("should skip default comparison when no baseline exists", () => {
    // When existingCol.dflt_value is undefined (old DDL without DEFAULT clause),
    // we can't detect changes — there's no baseline to compare against
    const desired = [
      field({ physicalName: "status", defaultValue: { kind: "value", value: "active" } }),
    ];
    const existing = [col("status", "TEXT", true)];
    const diff = computeColumnDiff(desired, existing);

    expect(diff.defaultChanged.length).toBe(0);
  });

  it("should detect default removed", () => {
    const desired = [field({ physicalName: "status" })];
    const existing = [col("status", "TEXT", false, false, "active")];
    const diff = computeColumnDiff(desired, existing);

    expect(diff.defaultChanged.length).toBe(1);
    expect(diff.defaultChanged[0].oldDefault).toBe("active");
    expect(diff.defaultChanged[0].newDefault).toBeUndefined();
  });

  it("should detect fn default change", () => {
    const desired = [field({ physicalName: "createdAt", defaultValue: { kind: "fn", fn: "now" } })];
    const existing = [col("createdAt", "INTEGER", false, false, "fn:uuid")];
    const diff = computeColumnDiff(desired, existing);

    expect(diff.defaultChanged.length).toBe(1);
    expect(diff.defaultChanged[0].oldDefault).toBe("fn:uuid");
    expect(diff.defaultChanged[0].newDefault).toBe("fn:now");
  });

  it("should not report default change when defaults match", () => {
    const desired = [
      field({ physicalName: "status", defaultValue: { kind: "value", value: "active" } }),
    ];
    const existing = [col("status", "TEXT", false, false, "active")];
    const diff = computeColumnDiff(desired, existing);

    expect(diff.defaultChanged.length).toBe(0);
  });

  it("should detect rename conflict when target name already exists", () => {
    // "email" field has renamedFrom: 'name', but 'email' already exists as a column
    const desired = [
      field({ physicalName: "id", isPrimaryKey: true }),
      field({ physicalName: "email", renamedFrom: "name" }),
    ];
    const existing = [col("id", "INTEGER", false, true), col("name"), col("email")];
    const diff = computeColumnDiff(desired, existing);

    expect(diff.conflicts.length).toBe(1);
    expect(diff.conflicts[0].field.physicalName).toBe("email");
    expect(diff.conflicts[0].oldName).toBe("name");
    expect(diff.conflicts[0].conflictsWith).toBe("email");
    // Should not appear in renamed
    expect(diff.renamed.length).toBe(0);
    // 'name' should not appear in removed (it's consumed by the conflict)
    expect(diff.removed.find((c) => c.name === "name")).toBeUndefined();
  });

  it("should allow rename when target name does not exist", () => {
    const desired = [
      field({ physicalName: "id", isPrimaryKey: true }),
      field({ physicalName: "full_name", renamedFrom: "name" }),
    ];
    const existing = [col("id", "INTEGER", false, true), col("name")];
    const diff = computeColumnDiff(desired, existing);

    expect(diff.conflicts.length).toBe(0);
    expect(diff.renamed.length).toBe(1);
    expect(diff.renamed[0].oldName).toBe("name");
    expect(diff.renamed[0].field.physicalName).toBe("full_name");
  });
});

// ── Primary-key field-set change (since 0.1.128) ─────────────────────────

describe("computeColumnDiff — primaryKeyChanged", () => {
  it("reports no change when the PK set is identical", () => {
    const desired = [
      field({ physicalName: "id", isPrimaryKey: true }),
      field({ physicalName: "n" }),
    ];
    const existing = [col("id", "INTEGER", true, true), col("n")];
    expect(computeColumnDiff(desired, existing).primaryKeyChanged).toBeUndefined();
  });

  it("detects the PK moved to another existing column", () => {
    const desired = [
      field({ physicalName: "id", designType: "number" }),
      field({ physicalName: "code", isPrimaryKey: true }),
    ];
    const existing = [col("id", "INTEGER", true, true), col("code", "TEXT", true)];
    const diff = computeColumnDiff(desired, existing);
    expect(diff.primaryKeyChanged).toEqual({ from: ["id"], to: ["code"] });
    // Column-level diff is otherwise clean — both columns exist
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("detects single → composite", () => {
    const desired = [
      field({ physicalName: "studentId", isPrimaryKey: true }),
      field({ physicalName: "courseId", isPrimaryKey: true }),
    ];
    const existing = [col("id", "INTEGER", true, true), col("studentId"), col("courseId")];
    const diff = computeColumnDiff(desired, existing);
    expect(diff.primaryKeyChanged).toEqual({ from: ["id"], to: ["studentId", "courseId"] });
    expect(diff.removed.map((c) => c.name)).toEqual(["id"]);
  });

  it("detects composite → single", () => {
    const desired = [
      field({ physicalName: "id", isPrimaryKey: true }),
      field({ physicalName: "studentId" }),
      field({ physicalName: "courseId" }),
    ];
    const existing = [
      col("studentId", "INTEGER", true, true),
      col("courseId", "INTEGER", true, true),
      col("id", "INTEGER", true),
    ];
    expect(computeColumnDiff(desired, existing).primaryKeyChanged).toEqual({
      from: ["studentId", "courseId"],
      to: ["id"],
    });
  });

  it("detects composite membership change", () => {
    const desired = [
      field({ physicalName: "a", isPrimaryKey: true }),
      field({ physicalName: "c", isPrimaryKey: true }),
      field({ physicalName: "b" }),
    ];
    const existing = [col("a", "TEXT", true, true), col("b", "TEXT", true, true), col("c")];
    expect(computeColumnDiff(desired, existing).primaryKeyChanged).toEqual({
      from: ["a", "b"],
      to: ["a", "c"],
    });
  });

  it("does NOT detect a composite reorder (set semantics)", () => {
    const desired = [
      field({ physicalName: "b", isPrimaryKey: true }),
      field({ physicalName: "a", isPrimaryKey: true }),
    ];
    const existing = [col("a", "TEXT", true, true), col("b", "TEXT", true, true)];
    expect(computeColumnDiff(desired, existing).primaryKeyChanged).toBeUndefined();
  });

  it("maps a renamed PK column to its new name (no false change)", () => {
    const desired = [field({ physicalName: "uid", isPrimaryKey: true, renamedFrom: "id" })];
    const existing = [col("id", "INTEGER", true, true)];
    const diff = computeColumnDiff(desired, existing);
    expect(diff.renamed).toHaveLength(1);
    expect(diff.primaryKeyChanged).toBeUndefined();
  });

  it("detects a PK move onto a newly added column", () => {
    const desired = [
      field({ physicalName: "id", designType: "number" }),
      field({ physicalName: "code", isPrimaryKey: true }),
    ];
    const existing = [col("id", "INTEGER", true, true)];
    const diff = computeColumnDiff(desired, existing);
    expect(diff.added.map((f) => f.physicalName)).toEqual(["code"]);
    expect(diff.primaryKeyChanged).toEqual({ from: ["id"], to: ["code"] });
  });

  it("ignores @db.ignore fields and reports nothing for a non-existent table", () => {
    const desired = [
      field({ physicalName: "id", isPrimaryKey: true }),
      field({ physicalName: "ghost", isPrimaryKey: true, ignored: true }),
    ];
    expect(
      computeColumnDiff(desired, [col("id", "INTEGER", true, true)]).primaryKeyChanged,
    ).toBeUndefined();
    expect(computeColumnDiff(desired, []).primaryKeyChanged).toBeUndefined();
  });

  it("detects a table gaining or losing its primary key entirely", () => {
    const gaining = computeColumnDiff(
      [field({ physicalName: "id", isPrimaryKey: true })],
      [col("id", "INTEGER", true, false)],
    );
    expect(gaining.primaryKeyChanged).toEqual({ from: [], to: ["id"] });
    const losing = computeColumnDiff(
      [field({ physicalName: "id" })],
      [col("id", "INTEGER", true, true)],
    );
    expect(losing.primaryKeyChanged).toEqual({ from: ["id"], to: [] });
  });
});
