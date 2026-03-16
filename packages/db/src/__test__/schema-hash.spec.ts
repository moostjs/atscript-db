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
