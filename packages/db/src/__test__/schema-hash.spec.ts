import { describe, it, expect } from "vite-plus/test";
import {
  computeTableSnapshot,
  computeSchemaHash,
  type TTableSnapshot,
} from "../schema/schema-hash";

// Minimal mock readable for testing
function mockReadable(
  overrides: Partial<{
    tableName: string;
    fieldDescriptors: any[];
    indexes: Map<string, any>;
    foreignKeys: Map<string, any>;
  }> = {},
) {
  return {
    tableName: overrides.tableName ?? "test_table",
    fieldDescriptors: overrides.fieldDescriptors ?? [
      {
        path: "id",
        physicalName: "id",
        designType: "number",
        optional: false,
        isPrimaryKey: true,
        ignored: false,
        storage: "column",
      },
      {
        path: "name",
        physicalName: "name",
        designType: "string",
        optional: false,
        isPrimaryKey: false,
        ignored: false,
        storage: "column",
      },
    ],
    indexes: overrides.indexes ?? new Map(),
    foreignKeys: overrides.foreignKeys ?? new Map(),
  } as any;
}

describe("schema-hash", () => {
  describe("computeTableSnapshot", () => {
    it("should extract fields sorted by physicalName", () => {
      const readable = mockReadable({
        fieldDescriptors: [
          {
            path: "name",
            physicalName: "name",
            designType: "string",
            optional: false,
            isPrimaryKey: false,
            ignored: false,
            storage: "column",
          },
          {
            path: "id",
            physicalName: "id",
            designType: "number",
            optional: false,
            isPrimaryKey: true,
            ignored: false,
            storage: "column",
          },
        ],
      });
      const snapshot = computeTableSnapshot(readable);
      expect(snapshot.fields[0].physicalName).toBe("id");
      expect(snapshot.fields[1].physicalName).toBe("name");
    });

    it("should exclude ignored fields", () => {
      const readable = mockReadable({
        fieldDescriptors: [
          {
            path: "id",
            physicalName: "id",
            designType: "number",
            optional: false,
            isPrimaryKey: true,
            ignored: false,
            storage: "column",
          },
          {
            path: "temp",
            physicalName: "temp",
            designType: "string",
            optional: true,
            isPrimaryKey: false,
            ignored: true,
            storage: "column",
          },
        ],
      });
      const snapshot = computeTableSnapshot(readable);
      expect(snapshot.fields.length).toBe(1);
      expect(snapshot.fields[0].physicalName).toBe("id");
    });

    it("should include indexes sorted by key", () => {
      const indexes = new Map([
        [
          "atscript__plain__name",
          { key: "atscript__plain__name", type: "plain", fields: [{ name: "name", sort: "asc" }] },
        ],
        [
          "atscript__unique__email",
          {
            key: "atscript__unique__email",
            type: "unique",
            fields: [{ name: "email", sort: "asc" }],
          },
        ],
      ]);
      const readable = mockReadable({ indexes });
      const snapshot = computeTableSnapshot(readable);
      expect(snapshot.indexes.length).toBe(2);
      expect(snapshot.indexes[0].key).toBe("atscript__plain__name");
      expect(snapshot.indexes[1].key).toBe("atscript__unique__email");
    });
  });

  describe("computeSchemaHash", () => {
    it("should be deterministic", () => {
      const snapshot: TTableSnapshot = {
        tableName: "users",
        fields: [
          {
            physicalName: "id",
            designType: "number",
            optional: false,
            isPrimaryKey: true,
            storage: "column",
          },
        ],
        indexes: [],
        foreignKeys: [],
      };
      const hash1 = computeSchemaHash([snapshot]);
      const hash2 = computeSchemaHash([snapshot]);
      expect(hash1).toBe(hash2);
    });

    it("should change when a field is added", () => {
      const base: TTableSnapshot = {
        tableName: "users",
        fields: [
          {
            physicalName: "id",
            designType: "number",
            optional: false,
            isPrimaryKey: true,
            storage: "column",
          },
        ],
        indexes: [],
        foreignKeys: [],
      };
      const withField: TTableSnapshot = {
        ...base,
        fields: [
          ...base.fields,
          {
            physicalName: "email",
            designType: "string",
            optional: false,
            isPrimaryKey: false,
            storage: "column",
          },
        ],
      };
      expect(computeSchemaHash([base])).not.toBe(computeSchemaHash([withField]));
    });

    it("should change when an index is added", () => {
      const base: TTableSnapshot = {
        tableName: "users",
        fields: [
          {
            physicalName: "id",
            designType: "number",
            optional: false,
            isPrimaryKey: true,
            storage: "column",
          },
        ],
        indexes: [],
        foreignKeys: [],
      };
      const withIndex: TTableSnapshot = {
        ...base,
        indexes: [
          {
            key: "atscript__unique__email",
            type: "unique",
            fields: [{ name: "email", sort: "asc" }],
          },
        ],
      };
      expect(computeSchemaHash([base])).not.toBe(computeSchemaHash([withIndex]));
    });

    it("should be stable regardless of table order", () => {
      const table1: TTableSnapshot = {
        tableName: "a_users",
        fields: [],
        indexes: [],
        foreignKeys: [],
      };
      const table2: TTableSnapshot = {
        tableName: "b_posts",
        fields: [],
        indexes: [],
        foreignKeys: [],
      };
      expect(computeSchemaHash([table1, table2])).toBe(computeSchemaHash([table2, table1]));
    });
  });
});

// ── View snapshot canonicalization (since 0.1.128) ──────────────────────

import { beforeAll } from "vite-plus/test";
import { DbSpace } from "../index";
import { MockAdapter, prepareFixtures } from "./test-utils";
import {
  computeViewSnapshot,
  computeTableHash,
  canonicalizeQueryNode,
} from "../schema/schema-hash";

describe("computeViewSnapshot — joins, filter, having", () => {
  let fx: Record<string, any>;

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/view-hash.as");
  });

  function snapshotOf(type: any) {
    return computeViewSnapshot(new DbSpace(() => new MockAdapter()).getView(type));
  }

  it("stores each join with its canonical ON condition", () => {
    const snap = snapshotOf(fx.VhJoinA);
    expect(snap.joinTables).toEqual([
      {
        targetTable: "vh_users",
        condition: JSON.stringify({ l: "vh_users.id", op: "$eq", r: { f: "vh_tasks.assigneeId" } }),
      },
    ]);
  });

  it("changes the hash when only the join condition changes", () => {
    const a = snapshotOf(fx.VhJoinA);
    const b = snapshotOf(fx.VhJoinB);
    expect(a.entryTable).toBe(b.entryTable);
    expect(a.joinTables![0].targetTable).toBe(b.joinTables![0].targetTable);
    expect(a.fields).toEqual(b.fields);
    expect(computeTableHash(a)).not.toBe(computeTableHash(b));
  });

  it("changes the hash when a filter is retargeted to another table (same field name)", () => {
    const a = snapshotOf(fx.VhFilterA);
    const b = snapshotOf(fx.VhFilterB);
    expect(a.filterHash).toBeDefined();
    expect(a.filterHash).not.toBe(b.filterHash);
    expect(computeTableHash(a)).not.toBe(computeTableHash(b));
  });

  it("hashes @db.view.having", () => {
    const a = snapshotOf(fx.VhHavingA);
    const b = snapshotOf(fx.VhHavingB);
    expect(a.havingHash).toBeDefined();
    expect(a.havingHash).not.toBe(b.havingHash);
    expect(computeTableHash(a)).not.toBe(computeTableHash(b));
  });

  it("serializes a join-less view exactly as before (joinTables: [])", () => {
    const snap = snapshotOf(fx.VhPlain);
    expect(snap.joinTables).toEqual([]);
    expect(snap.filterHash).toBeUndefined();
    expect(snap.havingHash).toBeUndefined();
    expect(Object.keys(snap)).toEqual([
      "tableName",
      "viewType",
      "entryTable",
      "joinTables",
      "materialized",
      "fields",
    ]);
    // Ignored fields are excluded from the snapshot as they are from the DDL
    expect(snap.fields.some((f) => f.physicalName === "computed")).toBe(false);
  });

  it("is byte-identical across two constructions of the same view", () => {
    const a = JSON.stringify(snapshotOf(fx.VhFilterA));
    const b = JSON.stringify(snapshotOf(fx.VhFilterA));
    expect(a).toBe(b);
  });
});

describe("canonicalizeQueryNode", () => {
  // The view's `resolveFieldRef(ref, (n) => n)`: "<table>.<field>", unquoted
  const resolve = (ref: { type?: () => any; field: string }) =>
    `${ref.type ? (ref.type().metadata.get("db.table") as string) : "entry"}.${ref.field}`;
  const users = () => ({ metadata: new Map([["db.table", "users"]]) });

  it("qualifies refs, keeps operators/values, and fixes key order", () => {
    const node = {
      $and: [
        { left: { field: "status" }, op: "$eq", right: "active" },
        { left: { type: users, field: "id" }, op: "$eq", right: { type: users, field: "ownerId" } },
        {
          $or: [
            { left: { field: "n" }, op: "$gt", right: 5 },
            { $not: { left: { field: "deleted" }, op: "$exists" } },
          ],
        },
        { left: { field: "tag" }, op: "$in", right: ["a", "b"] },
        { left: { field: "gone" }, op: "$eq", right: null },
      ],
    } as any;
    expect(canonicalizeQueryNode(node, resolve as any)).toEqual({
      and: [
        { l: "entry.status", op: "$eq", r: "active" },
        { l: "users.id", op: "$eq", r: { f: "users.ownerId" } },
        { or: [{ l: "entry.n", op: "$gt", r: 5 }, { not: { l: "entry.deleted", op: "$exists" } }] },
        { l: "entry.tag", op: "$in", r: ["a", "b"] },
        { l: "entry.gone", op: "$eq", r: null },
      ],
    });
    // No function survives — JSON round-trips losslessly
    const json = JSON.stringify(canonicalizeQueryNode(node, resolve as any));
    expect(json).not.toContain("[fn]");
    expect(JSON.parse(json)).toEqual(canonicalizeQueryNode(node, resolve as any));
  });
});
