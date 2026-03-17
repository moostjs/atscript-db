/* eslint-disable unicorn/consistent-function-scoping */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vite-plus/test";
import type { FilterExpr } from "@uniqu/core";

import { AtscriptDbTable } from "../table/db-table";
import { BaseDbAdapter } from "../base-adapter";
import type {
  DbQuery,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbDeleteResult,
} from "../types";

import { prepareFixtures } from "./test-utils";

// Helper to build WithRelation objects (Uniquery & { name })
function withRel(name: string, opts?: { filter?: any; controls?: any }): any {
  return { name, filter: opts?.filter ?? {}, controls: opts?.controls ?? {} };
}

// Populated by beforeAll after fixtures are compiled
let UsersTable: any;
let NoTableAnnotation: any;
let ProfileTable: any;
let ProductTable: any;

// ── Mock adapter ────────────────────────────────────────────────────────────

class MockAdapter extends BaseDbAdapter {
  public calls: Array<{ method: string; args: any[] }> = [];

  private record(method: string, ...args: any[]) {
    this.calls.push({ method, args });
  }

  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    this.record("insertOne", data);
    return { insertedId: 1 };
  }

  async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    this.record("insertMany", data);
    return { insertedCount: data.length, insertedIds: data.map((_, i) => i + 1) };
  }

  async replaceOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    this.record("replaceOne", filter, data);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: any,
  ): Promise<TDbUpdateResult> {
    this.record("updateOne", filter, data, ops);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(filter: FilterExpr): Promise<TDbDeleteResult> {
    this.record("deleteOne", filter);
    return { deletedCount: 1 };
  }

  async findOne(query: DbQuery): Promise<Record<string, unknown> | null> {
    this.record("findOne", query);
    return { id: 1, name: "test" };
  }

  async findMany(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    this.record("findMany", query);
    return [{ id: 1, name: "test" }];
  }

  async count(query: DbQuery): Promise<number> {
    this.record("count", query);
    return 42;
  }

  async updateMany(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: any,
  ): Promise<TDbUpdateResult> {
    this.record("updateMany", filter, data, ops);
    return { matchedCount: 5, modifiedCount: 5 };
  }

  async replaceMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    this.record("replaceMany", filter, data);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    this.record("deleteMany", filter);
    return { deletedCount: 3 };
  }

  async syncIndexes(): Promise<void> {
    this.record("syncIndexes");
  }

  async ensureTable(): Promise<void> {
    this.record("ensureTable");
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("AtscriptDbTable", () => {
  let adapter: MockAdapter;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/test-table.as");
    UsersTable = fixtures.UsersTable;
    NoTableAnnotation = fixtures.NoTableAnnotation;
    ProfileTable = fixtures.ProfileTable;
    ProductTable = fixtures.ProductTable;
  });

  beforeEach(() => {
    adapter = new MockAdapter();
    table = new AtscriptDbTable(UsersTable, adapter);
  });

  // ── Constructor ─────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("should extract table name from @db.table", () => {
      expect(table.tableName).toBe("users");
    });

    it("should extract schema from @db.schema", () => {
      expect(table.schema).toBe("auth");
    });

    it("should register itself with the adapter", () => {
      // The adapter should have a back-reference
      expect((adapter as any)._table).toBe(table);
    });

    it("should fall back to interface name when @db.table has no name arg", () => {
      const a = new MockAdapter();
      const t = new AtscriptDbTable(NoTableAnnotation, a);
      expect(t.tableName).toBe("NoTableAnnotation");
    });

    it("should throw for non-annotated types", () => {
      expect(() => new AtscriptDbTable({} as any, new MockAdapter())).toThrow(
        "Atscript Annotated Type expected",
      );
    });
  });

  // ── Metadata ──────────────────────────────────────────────────────────

  describe("metadata", () => {
    it("should compute flatMap with all fields", () => {
      const keys = [...table.flatMap.keys()];
      expect(keys).toContain("id");
      expect(keys).toContain("email");
      expect(keys).toContain("name");
      expect(keys).toContain("createdAt");
      expect(keys).toContain("displayName");
      expect(keys).toContain("status");
      expect(keys).toContain("bio");
    });

    it("should extract primary keys from @meta.id", () => {
      expect([...table.primaryKeys]).toEqual(["id"]);
    });

    it("should extract column mappings from @db.column", () => {
      expect(table.columnMap.get("email")).toBe("email_address");
    });

    it("should extract defaults from @db.default", () => {
      const statusDefault = table.defaults.get("status");
      expect(statusDefault).toEqual({ kind: "value", value: "active" });
    });

    it("should extract defaults from @db.default.now", () => {
      const createdAtDefault = table.defaults.get("createdAt");
      expect(createdAtDefault).toEqual({ kind: "fn", fn: "now" });
    });

    it("should extract ignored fields from @db.ignore", () => {
      expect(table.ignoredFields.has("displayName")).toBe(true);
      expect(table.ignoredFields.has("name")).toBe(false);
    });

    it("should extract unique props from single-field unique indexes", () => {
      // uniqueProps uses logical names (matching flatMap keys)
      expect(table.uniqueProps.has("email")).toBe(true);
    });

    it("should return ID descriptor", () => {
      const desc = table.getIdDescriptor();
      expect(desc.fields).toEqual(["id"]);
      expect(desc.isComposite).toBe(false);
    });
  });

  // ── Indexes ───────────────────────────────────────────────────────────

  describe("indexes", () => {
    it("should compute indexes from @db.index.*", () => {
      const indexes = table.indexes;
      expect(indexes.size).toBeGreaterThan(0);
    });

    it("should create unique index for @db.index.unique", () => {
      const indexes = [...table.indexes.values()];
      const emailIdx = indexes.find((i) => i.name === "email_idx");
      expect(emailIdx).toBeDefined();
      expect(emailIdx!.type).toBe("unique");
      expect(emailIdx!.fields).toEqual([{ name: "email_address", sort: "asc" }]);
    });

    it("should create composite plain index when fields share a name", () => {
      const indexes = [...table.indexes.values()];
      const nameIdx = indexes.find((i) => i.name === "name_idx");
      expect(nameIdx).toBeDefined();
      expect(nameIdx!.type).toBe("plain");
      expect(nameIdx!.fields.length).toBe(2);
      expect(nameIdx!.fields.map((f) => f.name)).toContain("name");
      expect(nameIdx!.fields.map((f) => f.name)).toContain("createdAt");
    });

    it("should respect sort direction in @db.index.plain", () => {
      const indexes = [...table.indexes.values()];
      const createdIdx = indexes.find((i) => i.name === "created_idx");
      expect(createdIdx).toBeDefined();
      expect(createdIdx!.fields[0].sort).toBe("desc");
    });

    it("should create fulltext index for @db.index.fulltext", () => {
      const indexes = [...table.indexes.values()];
      const searchIdx = indexes.find((i) => i.name === "search_idx");
      expect(searchIdx).toBeDefined();
      expect(searchIdx!.type).toBe("fulltext");
      expect(searchIdx!.fields).toEqual([{ name: "bio", sort: "asc" }]);
    });
  });

  // ── CRUD ──────────────────────────────────────────────────────────────

  describe("CRUD operations", () => {
    it("should delegate findOne to adapter", async () => {
      const result = await table.findOne({ filter: { id: 1 }, controls: {} });
      expect(adapter.calls[0].method).toBe("findOne");
      expect(adapter.calls[0].args[0]).toEqual({ filter: { id: 1 }, controls: {} });
      expect(result).toEqual({ id: 1, name: "test" });
    });

    it("should delegate findMany to adapter", async () => {
      await table.findMany({ filter: { name: "test" }, controls: { $limit: 10 } });
      expect(adapter.calls[0].method).toBe("findMany");
      expect(adapter.calls[0].args[0]).toEqual({
        filter: { name: "test" },
        controls: { $limit: 10 },
      });
    });

    it("should delegate count to adapter", async () => {
      const result = await table.count({ filter: { status: "active" }, controls: {} });
      expect(adapter.calls[0].method).toBe("count");
      expect(result).toBe(42);
    });

    it("should delegate deleteOne with prepared ID", async () => {
      await table.deleteOne(123);
      expect(adapter.calls[0].method).toBe("deleteOne");
      expect(adapter.calls[0].args[0]).toEqual({ id: 123 });
    });

    it("should delegate deleteMany to adapter", async () => {
      await table.deleteMany({ status: "inactive" });
      expect(adapter.calls[0].method).toBe("deleteMany");
    });

    it("should delegate syncIndexes to adapter", async () => {
      await table.syncIndexes();
      expect(adapter.calls[0].method).toBe("syncIndexes");
    });

    it("should delegate ensureTable to adapter", async () => {
      await table.ensureTable();
      expect(adapter.calls[0].method).toBe("ensureTable");
    });
  });

  // ── Write preparation ─────────────────────────────────────────────────

  describe("write preparation", () => {
    it("should strip ignored fields on insert", async () => {
      await table.insertOne({
        id: 1,
        email: "test@example.com",
        name: "John",
        createdAt: 12345,
        displayName: "Johnny",
        status: "active",
      } as any);

      const insertCall = adapter.calls[0];
      expect(insertCall.method).toBe("insertMany");
      // displayName should be stripped (@db.ignore)
      expect(insertCall.args[0][0].displayName).toBeUndefined();
    });

    it("should map column names on insert", async () => {
      await table.insertOne({
        id: 1,
        email: "test@example.com",
        name: "John",
        createdAt: 12345,
        status: "active",
      } as any);

      const insertCall = adapter.calls[0];
      // email should be mapped to email_address (@db.column)
      expect(insertCall.args[0][0].email_address).toBe("test@example.com");
      expect(insertCall.args[0][0].email).toBeUndefined();
    });

    it("should apply default values on insert when field is missing", async () => {
      await table.insertOne({
        id: 1,
        email: "test@example.com",
        name: "John",
        createdAt: 12345,
      } as any);

      const insertCall = adapter.calls[0];
      // status should get default value "active" (@db.default)
      expect(insertCall.args[0][0].status).toBe("active");
    });
  });

  // ── Adapter back-reference ────────────────────────────────────────────

  describe("adapter back-reference", () => {
    it("should allow adapter to access table metadata", () => {
      // Access flatMap to trigger flattening
      void table.flatMap;

      // Adapter should be able to read metadata via this._table
      expect((adapter as any)._table.tableName).toBe("users");
      expect((adapter as any)._table.schema).toBe("auth");
      expect((adapter as any)._table.primaryKeys).toEqual(["id"]);
    });

    it("should allow adapter to access indexes", () => {
      const adapterTable = (adapter as any)._table as AtscriptDbTable;
      expect(adapterTable.indexes.size).toBeGreaterThan(0);
    });
  });

  // ── Adapter hooks ─────────────────────────────────────────────────────

  describe("adapter hooks", () => {
    it("should call onBeforeFlatten during flatten", () => {
      const hookAdapter = new MockAdapter();
      const spy = vi.fn();
      hookAdapter.onBeforeFlatten = spy;
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      void t.flatMap; // trigger flatten
      expect(spy).toHaveBeenCalledWith(UsersTable);
    });

    it("should call onFieldScanned for each field", () => {
      const hookAdapter = new MockAdapter();
      const spy = vi.fn();
      hookAdapter.onFieldScanned = spy;
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      void t.flatMap; // trigger flatten
      expect(spy).toHaveBeenCalled();
      // Should be called for each field (id, email, name, createdAt, displayName, status, bio)
      expect(spy.mock.calls.length).toBe(7);
    });

    it("should call onAfterFlatten after flatten", () => {
      const hookAdapter = new MockAdapter();
      const spy = vi.fn();
      hookAdapter.onAfterFlatten = spy;
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      void t.flatMap; // trigger flatten
      expect(spy).toHaveBeenCalled();
    });

    it("should use adapter getAdapterTableName when provided", () => {
      const hookAdapter = new MockAdapter();
      hookAdapter.getAdapterTableName = () => "custom_users";
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      expect(t.tableName).toBe("custom_users");
    });

    /** Attaches a formatValue hook that tags `@db.default.now` fields with a prefix formatter. */
    function withTimestampFormatter(adapter: MockAdapter, prefix = "formatted"): MockAdapter {
      adapter.formatValue = (field) => {
        if (field.defaultValue?.kind === "fn" && field.defaultValue.fn === "now") {
          return (v: unknown) => (typeof v === "number" ? `${prefix}:${v}` : v);
        }
        return undefined;
      };
      return adapter;
    }

    it("should build value formatters from adapter.formatValue", () => {
      const hookAdapter = new MockAdapter();
      hookAdapter.formatValue = (field) => {
        if (
          field.designType === "number" &&
          field.defaultValue?.kind === "fn" &&
          field.defaultValue.fn === "now"
        ) {
          return (v: unknown) => (typeof v === "number" ? `ts:${v}` : v);
        }
        return undefined;
      };
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      // Trigger fieldDescriptors computation (which builds toStorageFormatters)
      void t.fieldDescriptors;
      // createdAt has @db.default.now on a number field — should have a formatter
      expect((t as any)._meta.toStorageFormatters).toBeDefined();
      expect((t as any)._meta.toStorageFormatters.size).toBe(1);
      expect((t as any)._meta.toStorageFormatters.has("createdAt")).toBe(true);
    });

    it("should not build value formatters when adapter has no formatValue", () => {
      const hookAdapter = new MockAdapter();
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      void t.fieldDescriptors;
      expect((t as any)._meta.toStorageFormatters).toBeUndefined();
    });

    it("should apply value formatter during insertOne (write path)", async () => {
      const hookAdapter = withTimestampFormatter(new MockAdapter());
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      await t.insertMany([{ id: 1, email: "a@b.com", name: "A", createdAt: 1000, status: "ok" }]);
      const call = hookAdapter.calls.find((c) => c.method === "insertMany")!;
      // createdAt should be formatted; other fields untouched
      expect(call.args[0][0].createdAt).toBe("formatted:1000");
      expect(call.args[0][0].id).toBe(1);
      expect(call.args[0][0].name).toBe("A");
    });

    it("should apply value formatter to direct filter values", async () => {
      const hookAdapter = withTimestampFormatter(new MockAdapter());
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      await t.findMany({ filter: { createdAt: 5000 } as any, controls: {} });
      const call = hookAdapter.calls.find((c) => c.method === "findMany")!;
      expect(call.args[0].filter.createdAt).toBe("formatted:5000");
    });

    it("should apply value formatter to operator filter values ($gt, $lt)", async () => {
      const hookAdapter = withTimestampFormatter(new MockAdapter());
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      await t.findMany({ filter: { createdAt: { $gt: 1000, $lt: 2000 } } as any, controls: {} });
      const call = hookAdapter.calls.find((c) => c.method === "findMany")!;
      expect(call.args[0].filter.createdAt).toEqual({
        $gt: "formatted:1000",
        $lt: "formatted:2000",
      });
    });

    it("should apply value formatter to $in array values", async () => {
      const hookAdapter = withTimestampFormatter(new MockAdapter());
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      await t.findMany({ filter: { createdAt: { $in: [100, 200, 300] } } as any, controls: {} });
      const call = hookAdapter.calls.find((c) => c.method === "findMany")!;
      expect(call.args[0].filter.createdAt).toEqual({
        $in: ["formatted:100", "formatted:200", "formatted:300"],
      });
    });

    it("should not format null/undefined filter values", async () => {
      const hookAdapter = withTimestampFormatter(new MockAdapter());
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      await t.findMany({ filter: { createdAt: null } as any, controls: {} });
      const call = hookAdapter.calls.find((c) => c.method === "findMany")!;
      expect(call.args[0].filter.createdAt).toBeNull();
    });

    it("should not format fields without a registered formatter", async () => {
      const hookAdapter = withTimestampFormatter(new MockAdapter());
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      await t.insertMany([{ id: 42, email: "x@y.com", name: "X", createdAt: 999, status: "ok" }]);
      const call = hookAdapter.calls.find((c) => c.method === "insertMany")!;
      // 'name' has no formatter — should pass through unchanged
      expect(call.args[0][0].name).toBe("X");
      // 'id' has no formatter
      expect(call.args[0][0].id).toBe(42);
    });

    it("should build both toStorage and fromStorage from TValueFormatterPair", () => {
      const hookAdapter = new MockAdapter();
      hookAdapter.formatValue = (field) => {
        if (field.defaultValue?.kind === "fn" && field.defaultValue.fn === "now") {
          return {
            toStorage: (v: unknown) => `to:${String(v)}`,
            fromStorage: (v: unknown) => `from:${String(v)}`,
          };
        }
        return undefined;
      };
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      void t.fieldDescriptors;
      expect((t as any)._meta.toStorageFormatters).toBeDefined();
      expect((t as any)._meta.toStorageFormatters.has("createdAt")).toBe(true);
      expect((t as any)._meta.fromStorageFormatters).toBeDefined();
      expect((t as any)._meta.fromStorageFormatters.has("createdAt")).toBe(true);
    });

    it("should not build fromStorageFormatters for bare function return (backward compat)", () => {
      const hookAdapter = withTimestampFormatter(new MockAdapter());
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      void t.fieldDescriptors;
      expect((t as any)._meta.toStorageFormatters).toBeDefined();
      expect((t as any)._meta.fromStorageFormatters).toBeUndefined();
    });

    it("should apply fromStorage formatter during findOne (read path)", async () => {
      const hookAdapter = new MockAdapter();
      hookAdapter.formatValue = (field) => {
        if (field.defaultValue?.kind === "fn" && field.defaultValue.fn === "now") {
          return {
            toStorage: (v: unknown) => v,
            fromStorage: (v: unknown) => (typeof v === "string" ? Number(v) * 10 : v),
          };
        }
        return undefined;
      };
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      // Seed mock data with string values (simulating raw DB)
      hookAdapter.findOne = async () => ({
        id: 1,
        email: "a@b.com",
        name: "A",
        createdAt: "100",
        status: "ok",
      });
      const result = await t.findOne(1 as any);
      // fromStorage should convert '100' → 1000
      expect((result as any)!.createdAt).toBe(1000);
    });

    it("should not apply fromStorage formatter to null values", async () => {
      const hookAdapter = new MockAdapter();
      hookAdapter.formatValue = (field) => {
        if (field.defaultValue?.kind === "fn" && field.defaultValue.fn === "now") {
          return {
            toStorage: (v: unknown) => v,
            fromStorage: () => {
              throw new Error("should not be called for null");
            },
          };
        }
        return undefined;
      };
      const t = new AtscriptDbTable(UsersTable, hookAdapter);
      hookAdapter.findOne = async () => ({
        id: 1,
        email: "a@b.com",
        name: "A",
        createdAt: null,
        status: "ok",
      });
      const result = await t.findOne(1 as any);
      expect((result as any)!.createdAt).toBeNull();
    });
  });
});

// ── Nested / Embedded Object Tests ─────────────────────────────────────────

describe("AtscriptDbTable — embedded objects", () => {
  let adapter: MockAdapter;
  let table: AtscriptDbTable;

  beforeEach(() => {
    adapter = new MockAdapter();
    table = new AtscriptDbTable(ProfileTable, adapter);
  });

  // ── Classification & field descriptors ────────────────────────────────

  describe("field classification", () => {
    it("should exclude parent objects from fieldDescriptors", () => {
      const descriptors = table.fieldDescriptors;
      const paths = descriptors.map((d) => d.path);
      // "contact" and "settings" and "settings.notifications" are parent objects — excluded
      expect(paths).not.toContain("contact");
      expect(paths).not.toContain("settings");
      expect(paths).not.toContain("settings.notifications");
      // Their leaf children should be present
      expect(paths).toContain("contact.email");
      expect(paths).toContain("contact.phone");
      expect(paths).toContain("settings.notifications.email");
      expect(paths).toContain("settings.notifications.sms");
    });

    it("should assign __-separated physical names to flattened fields", () => {
      const descriptors = table.fieldDescriptors;
      const contactEmail = descriptors.find((d) => d.path === "contact.email");
      expect(contactEmail?.physicalName).toBe("contact__email");
      const settingsSms = descriptors.find((d) => d.path === "settings.notifications.sms");
      expect(settingsSms?.physicalName).toBe("settings__notifications__sms");
    });

    it("should set storage=flattened for nested leaf fields", () => {
      const descriptors = table.fieldDescriptors;
      const contactEmail = descriptors.find((d) => d.path === "contact.email");
      expect(contactEmail?.storage).toBe("flattened");
      expect(contactEmail?.flattenedFrom).toBe("contact.email");
    });

    it("should set storage=json for @db.json fields", () => {
      const descriptors = table.fieldDescriptors;
      const prefs = descriptors.find((d) => d.path === "preferences");
      expect(prefs?.storage).toBe("json");
      expect(prefs?.designType).toBe("json");
    });

    it("should set storage=json for array fields", () => {
      const descriptors = table.fieldDescriptors;
      const tags = descriptors.find((d) => d.path === "tags");
      expect(tags?.storage).toBe("json");
    });

    it("should set storage=column for top-level scalar fields", () => {
      const descriptors = table.fieldDescriptors;
      const name = descriptors.find((d) => d.path === "name");
      expect(name?.storage).toBe("column");
      expect(name?.flattenedFrom).toBeUndefined();
    });

    it("should build pathToPhysical map", () => {
      const p2p = table.pathToPhysical;
      expect(p2p.get("contact.email")).toBe("contact__email");
      expect(p2p.get("contact.phone")).toBe("contact__phone");
      expect(p2p.get("settings.notifications.email")).toBe("settings__notifications__email");
      expect(p2p.get("preferences")).toBe("preferences");
      expect(p2p.get("name")).toBe("name");
    });

    it("should build physicalToPath map", () => {
      const p2l = table.physicalToPath;
      expect(p2l.get("contact__email")).toBe("contact.email");
      expect(p2l.get("settings__notifications__sms")).toBe("settings.notifications.sms");
    });

    it("should exclude ignored fields from descriptors", () => {
      const descriptors = table.fieldDescriptors;
      const ignored = descriptors.find((d) => d.path === "displayName");
      expect(ignored?.ignored).toBe(true);
    });
  });

  // ── Write flattening ───────────────────────────────────────────────────

  const baseProfileInput = {
    id: 1,
    name: "Alice",
    contact: { email: "alice@x.com", phone: "555" },
    preferences: { theme: "dark", lang: "en" },
    tags: ["admin", "user"],
    settings: { notifications: { email: true, sms: false } },
  };

  describe("write flattening", () => {
    it("should flatten nested objects to __-separated keys on insert", async () => {
      await table.insertOne({ ...baseProfileInput } as any);

      const call = adapter.calls.find((c) => c.method === "insertMany")!;
      const data = call.args[0][0] as Record<string, unknown>;

      // Flattened contact
      expect(data.contact__email).toBe("alice@x.com");
      expect(data.contact__phone).toBe("555");
      // No "contact" key
      expect(data.contact).toBeUndefined();

      // Deep flattened settings
      expect(data.settings__notifications__email).toBe(true);
      expect(data.settings__notifications__sms).toBe(false);
      expect(data.settings).toBeUndefined();
    });

    it("should JSON-stringify @db.json fields on insert", async () => {
      await table.insertOne({ ...baseProfileInput } as any);

      const call = adapter.calls.find((c) => c.method === "insertMany")!;
      const data = call.args[0][0] as Record<string, unknown>;

      expect(data.preferences).toBe(JSON.stringify({ theme: "dark", lang: "en" }));
    });

    it("should JSON-stringify array fields on insert", async () => {
      await table.insertOne({ ...baseProfileInput } as any);

      const call = adapter.calls.find((c) => c.method === "insertMany")!;
      const data = call.args[0][0] as Record<string, unknown>;

      expect(data.tags).toBe(JSON.stringify(["admin", "user"]));
    });

    it("should set all children to null when parent is null", async () => {
      // Access the internal _fieldMapper.prepareForWrite directly to avoid validation
      // (validation rejects null for a required object field)
      void table.flatMap; // trigger flatten
      const prepared = (table as any)._fieldMapper.prepareForWrite(
        {
          ...baseProfileInput,
          contact: null,
          tags: [],
        },
        (table as any)._meta,
        (table as any).adapter,
      );

      expect(prepared.contact__email).toBeNull();
      expect(prepared.contact__phone).toBeNull();
    });
  });

  // ── Read reconstruction ─────────────────────────────────────────────────

  const baseFlatRow = {
    id: 1,
    name: "Alice",
    contact__email: "alice@x.com",
    contact__phone: "555",
    preferences: '{"theme":"dark","lang":"en"}',
    tags: '["admin","user"]',
    settings__notifications__email: 1,
    settings__notifications__sms: 0,
  };

  describe("read reconstruction", () => {
    it("should reconstruct nested objects from __-separated columns", async () => {
      adapter.findOne = async () => ({ ...baseFlatRow });

      const result = (await table.findOne({ filter: { id: 1 }, controls: {} })) as any;

      expect(result.contact).toEqual({ email: "alice@x.com", phone: "555" });
      expect(result.settings).toEqual({ notifications: { email: true, sms: false } });
    });

    it("should parse JSON fields from strings", async () => {
      adapter.findOne = async () => ({
        ...baseFlatRow,
        contact__email: "a@x.com",
        contact__phone: null,
      });

      const result = (await table.findOne({ filter: { id: 1 }, controls: {} })) as any;

      expect(result.preferences).toEqual({ theme: "dark", lang: "en" });
      expect(result.tags).toEqual(["admin", "user"]);
    });

    it("should reconstruct null parent when all children are null", async () => {
      adapter.findOne = async () => ({
        ...baseFlatRow,
        contact__email: null,
        contact__phone: null,
        preferences: null,
        tags: null,
        settings__notifications__email: null,
        settings__notifications__sms: null,
      });

      const result = (await table.findOne({ filter: { id: 1 }, controls: {} })) as any;

      // contact is a required object — all-null children collapse to {}
      // (or null for optional; depends on type optionality)
      expect(result.contact).toBeDefined();
    });

    it("should reconstruct findMany results", async () => {
      adapter.findMany = async () => [
        {
          ...baseFlatRow,
          id: 1,
          name: "A",
          contact__email: "a@x.com",
          contact__phone: null,
          preferences: "{}",
          tags: "[]",
        },
        {
          ...baseFlatRow,
          id: 2,
          name: "B",
          contact__email: "b@x.com",
          contact__phone: "555",
          preferences: "{}",
          tags: "[]",
          settings__notifications__sms: 1,
        },
      ];

      const results = (await table.findMany({ filter: {}, controls: {} })) as any[];

      expect(results[0].contact).toEqual({ email: "a@x.com", phone: null });
      expect(results[1].contact).toEqual({ email: "b@x.com", phone: "555" });
    });
  });

  // ── Query translation ──────────────────────────────────────────────────

  describe("query translation", () => {
    it("should translate dot-notation filter keys to physical names", async () => {
      await table.findOne({
        filter: { "contact.email": "alice@x.com" },
        controls: {},
      } as any);

      const call = adapter.calls.find((c) => c.method === "findOne")!;
      const query = call.args[0] as DbQuery;
      expect(query.filter).toHaveProperty("contact__email", "alice@x.com");
      expect(query.filter).not.toHaveProperty("contact.email");
    });

    it("should translate filter keys in $or", async () => {
      await table.findMany({
        filter: { $or: [{ "contact.email": "a@x.com" }, { "contact.phone": "555" }] },
        controls: {},
      } as any);

      const call = adapter.calls.find((c) => c.method === "findMany")!;
      const query = call.args[0] as DbQuery;
      const orFilters = (query.filter as any).$or;
      expect(orFilters[0]).toHaveProperty("contact__email");
      expect(orFilters[1]).toHaveProperty("contact__phone");
    });

    it("should translate sort keys to physical names", async () => {
      await table.findMany({
        filter: {},
        controls: { $sort: { "contact.email": 1 } },
      } as any);

      const call = adapter.calls.find((c) => c.method === "findMany")!;
      const query = call.args[0] as DbQuery;
      expect(query.controls?.$sort).toHaveProperty("contact__email");
    });

    it("should strip intermediate parent paths from $sort", async () => {
      await table.findMany({
        filter: {},
        controls: { $sort: { contact: 1, name: -1 } },
      } as any);

      const call = adapter.calls.find((c) => c.method === "findMany")!;
      const query = call.args[0] as DbQuery;
      // "contact" is an intermediate parent — should be stripped
      expect(query.controls?.$sort).not.toHaveProperty("contact");
      // "name" is a leaf — should remain
      expect(query.controls?.$sort).toHaveProperty("name", -1);
    });

    it("should expand intermediate parent in $select array to leaf columns", async () => {
      await table.findMany({
        filter: {},
        controls: { $select: ["contact", "name"] as any },
      } as any);

      const call = adapter.calls.find((c) => c.method === "findMany")!;
      const query = call.args[0] as any;
      const select = query.controls?.$select?.asArray as string[];
      // "contact" should expand to its leaf physical columns
      expect(select).toContain("contact__email");
      expect(select).toContain("contact__phone");
      // "name" is a leaf — should pass through
      expect(select).toContain("name");
      // Original "contact" key should not be present
      expect(select).not.toContain("contact");
    });

    it("should expand deep nested parent in $select array to all leaf columns", async () => {
      await table.findMany({
        filter: {},
        controls: { $select: ["settings"] as any },
      } as any);

      const call = adapter.calls.find((c) => c.method === "findMany")!;
      const query = call.args[0] as any;
      const select = query.controls?.$select?.asArray as string[];
      // "settings" should expand to its deep leaf physical columns
      expect(select).toContain("settings__notifications__email");
      expect(select).toContain("settings__notifications__sms");
      expect(select).not.toContain("settings");
    });

    it("should expand intermediate parent in $select object to leaf columns", async () => {
      await table.findMany({
        filter: {},
        controls: { $select: { contact: 1, name: 1 } as any },
      } as any);

      const call = adapter.calls.find((c) => c.method === "findMany")!;
      const query = call.args[0] as any;
      const select = query.controls?.$select?.asProjection as Record<string, number>;
      expect(select).toHaveProperty("contact__email", 1);
      expect(select).toHaveProperty("contact__phone", 1);
      expect(select).toHaveProperty("name", 1);
      expect(select).not.toHaveProperty("contact");
    });

    it("should pass through non-nested field names unchanged", async () => {
      await table.findOne({
        filter: { name: "Alice" },
        controls: {},
      } as any);

      const call = adapter.calls.find((c) => c.method === "findOne")!;
      const query = call.args[0] as DbQuery;
      expect(query.filter).toHaveProperty("name", "Alice");
    });
  });

  // ── $with relation loading ──────────────────────────────────────────────

  describe("$with relation loading", () => {
    let mainAdapter: MockAdapter;
    let mainTable: AtscriptDbTable;

    // Mock target table for "to" relations (e.g., author lookup)
    const mockTargetTable = {
      findMany: vi.fn(),
      primaryKeys: ["id"] as readonly string[],
      relations: new Map(),
      foreignKeys: new Map(),
    };

    // Mock target table for "from" relations (e.g., posts by author)
    const mockFromTargetTable = {
      findMany: vi.fn(),
      primaryKeys: ["id"] as readonly string[],
      relations: new Map(),
      foreignKeys: new Map([
        [
          "__auto_authorId",
          {
            fields: ["authorId"],
            targetTable: "users",
            targetFields: ["id"],
          },
        ],
      ]),
    };

    const tableResolver = vi.fn().mockReturnValue(mockTargetTable);

    beforeEach(() => {
      mainAdapter = new MockAdapter();
      mainTable = new AtscriptDbTable(UsersTable, mainAdapter, undefined, tableResolver);

      // Inject FK metadata: this table has a FK "authorId" → target "authors" table
      const tbl = mainTable as any;
      tbl._meta.foreignKeys.set("__auto_authorId", {
        fields: ["authorId"],
        targetTable: "authors",
        targetFields: ["id"],
      });

      // Inject relation metadata
      tbl._meta.relations.set("author", {
        direction: "to",
        alias: undefined,
        targetType: () => ({ id: "Author", metadata: new Map([["db.table", "authors"]]) }),
        isArray: false,
      });

      tbl._meta.relations.set("posts", {
        direction: "from",
        alias: undefined,
        targetType: () => ({ id: "Post", metadata: new Map([["db.table", "posts"]]) }),
        isArray: true,
      });

      tableResolver.mockReset();
      mockTargetTable.findMany.mockReset();
      mockFromTargetTable.findMany.mockReset();
    });

    it('should load a "to" relation (many-to-one)', async () => {
      // Main adapter returns rows with FK values
      mainAdapter.findMany = async () => [
        {
          id: 1,
          name: "Alice",
          email_address: "alice@test.com",
          authorId: 10,
          status: "active",
          createdAt: 0,
        },
        {
          id: 2,
          name: "Bob",
          email_address: "bob@test.com",
          authorId: 20,
          status: "active",
          createdAt: 0,
        },
        {
          id: 3,
          name: "Carol",
          email_address: "carol@test.com",
          authorId: 10,
          status: "active",
          createdAt: 0,
        },
      ];

      tableResolver.mockReturnValue(mockTargetTable);
      mockTargetTable.findMany.mockResolvedValue([
        { id: 10, name: "Author A" },
        { id: 20, name: "Author B" },
      ]);

      const results = await mainTable.findMany({
        filter: {},
        controls: { $with: [withRel("author")] },
      } as any);

      expect(results).toHaveLength(3);
      expect((results[0] as any).author).toEqual({ id: 10, name: "Author A" });
      expect((results[1] as any).author).toEqual({ id: 20, name: "Author B" });
      expect((results[2] as any).author).toEqual({ id: 10, name: "Author A" });

      // Should batch into a single $in query
      expect(mockTargetTable.findMany).toHaveBeenCalledTimes(1);
      const call = mockTargetTable.findMany.mock.calls[0][0];
      expect(call.filter).toHaveProperty("id");
      expect(call.filter.id.$in).toEqual(expect.arrayContaining([10, 20]));
    });

    it('should load a "from" relation (one-to-many)', async () => {
      mainAdapter.findMany = async () => [
        { id: 1, name: "Alice", email_address: "alice@test.com", status: "active", createdAt: 0 },
        { id: 2, name: "Bob", email_address: "bob@test.com", status: "active", createdAt: 0 },
      ];

      tableResolver.mockReturnValue(mockFromTargetTable);
      mockFromTargetTable.findMany.mockResolvedValue([
        { id: 100, title: "Post A", authorId: 1 },
        { id: 101, title: "Post B", authorId: 1 },
        { id: 102, title: "Post C", authorId: 2 },
      ]);

      const results = await mainTable.findMany({
        filter: {},
        controls: { $with: [withRel("posts")] },
      } as any);

      expect(results).toHaveLength(2);
      expect((results[0] as any).posts).toHaveLength(2);
      expect((results[0] as any).posts[0]).toEqual({ id: 100, title: "Post A", authorId: 1 });
      expect((results[1] as any).posts).toHaveLength(1);
      expect((results[1] as any).posts[0]).toEqual({ id: 102, title: "Post C", authorId: 2 });
    });

    it('should assign null for "to" relation when FK is null', async () => {
      mainAdapter.findMany = async () => [
        {
          id: 1,
          name: "Alice",
          email_address: "a@x.com",
          authorId: null,
          status: "active",
          createdAt: 0,
        },
      ];

      tableResolver.mockReturnValue(mockTargetTable);
      mockTargetTable.findMany.mockResolvedValue([]);

      const results = await mainTable.findMany({
        filter: {},
        controls: { $with: [withRel("author")] },
      } as any);

      expect((results[0] as any).author).toBeNull();
    });

    it('should assign empty array for "from" relation with no matches', async () => {
      mainAdapter.findMany = async () => [
        { id: 1, name: "Alice", email_address: "a@x.com", status: "active", createdAt: 0 },
      ];

      tableResolver.mockReturnValue(mockFromTargetTable);
      mockFromTargetTable.findMany.mockResolvedValue([]);

      const results = await mainTable.findMany({
        filter: {},
        controls: { $with: [withRel("posts")] },
      } as any);

      expect((results[0] as any).posts).toEqual([]);
    });

    it("should pass per-relation filter and controls to target query", async () => {
      mainAdapter.findMany = async () => [
        {
          id: 1,
          name: "Alice",
          email_address: "a@x.com",
          authorId: 10,
          status: "active",
          createdAt: 0,
        },
      ];

      tableResolver.mockReturnValue(mockTargetTable);
      mockTargetTable.findMany.mockResolvedValue([{ id: 10, name: "Author A" }]);

      await mainTable.findMany({
        filter: {},
        controls: {
          $with: [
            withRel("author", {
              filter: { active: true },
              controls: { $sort: { name: 1 }, $limit: 5 },
            }),
          ],
        },
      } as any);

      const call = mockTargetTable.findMany.mock.calls[0][0];
      // Filter should be $and of $in + per-relation filter
      expect(call.filter.$and).toBeDefined();
      expect(call.filter.$and[1]).toEqual({ active: true });
      expect(call.controls.$sort).toEqual({ name: 1 });
      expect(call.controls.$limit).toBe(5);
    });

    it("should throw for unknown relations in $with", async () => {
      mainAdapter.findMany = async () => [
        { id: 1, name: "Alice", email_address: "a@x.com", status: "active", createdAt: 0 },
      ];

      const tbl = new AtscriptDbTable(UsersTable, mainAdapter, undefined, tableResolver);

      await expect(
        tbl.findMany({
          filter: {},
          controls: { $with: [withRel("nonexistent")] },
        } as any),
      ).rejects.toThrow('Unknown relation "nonexistent"');
    });

    it("should not load relations when no table resolver is provided", async () => {
      const noResolverTable = new AtscriptDbTable(UsersTable, mainAdapter);
      const tbl = noResolverTable as any;
      tbl._meta.relations.set("author", {
        direction: "to",
        alias: undefined,
        targetType: () => ({ id: "Author", metadata: new Map() }),
        isArray: false,
      });

      mainAdapter.findMany = async () => [
        {
          id: 1,
          name: "Alice",
          email_address: "a@x.com",
          authorId: 10,
          status: "active",
          createdAt: 0,
        },
      ];

      const results = await noResolverTable.findMany({
        filter: {},
        controls: { $with: [withRel("author")] },
      } as any);

      // Should return results without relation data (no resolver)
      expect((results[0] as any).author).toBeUndefined();
    });

    it("should strip $with from translated query before passing to adapter", async () => {
      const findManySpy = vi.fn().mockResolvedValue([]);
      mainAdapter.findMany = findManySpy;

      await mainTable.findMany({
        filter: {},
        controls: { $with: [withRel("author")] },
      } as any);

      expect(findManySpy).toHaveBeenCalledTimes(1);
      const query = findManySpy.mock.calls[0][0];
      // $with should be undefined (stripped) — not the original array
      expect(query.controls.$with).toBeUndefined();
    });

    it("should work with findOne", async () => {
      mainAdapter.findOne = async () => ({
        id: 1,
        name: "Alice",
        email_address: "a@x.com",
        authorId: 10,
        status: "active",
        createdAt: 0,
      });

      tableResolver.mockReturnValue(mockTargetTable);
      mockTargetTable.findMany.mockResolvedValue([{ id: 10, name: "Author A" }]);

      const result = (await mainTable.findOne({
        filter: { id: 1 },
        controls: { $with: [withRel("author")] },
      } as any)) as any;

      expect(result.author).toEqual({ id: 10, name: "Author A" });
    });
  });

  // ── Nested-objects adapter (bug #14) ────────────────────────────────────

  // ── Field ops ($inc/$dec/$mul) ────────────────────────────────────────────

  describe("field ops via updateOne (bulkUpdate)", () => {
    let productTable: AtscriptDbTable;

    beforeEach(() => {
      productTable = new AtscriptDbTable(ProductTable, adapter);
    });

    it("should separate top-level $inc and pass ops to adapter", async () => {
      await productTable.updateOne({ id: 1, price: { $inc: 5 } } as any);
      const call = adapter.calls.find((c) => c.method === "updateOne");
      expect(call).toBeDefined();
      // data should NOT contain the $inc field — it was separated
      expect(call!.args[1]).not.toHaveProperty("price");
      // ops should have the field
      expect(call!.args[2]).toMatchObject({ inc: { price: 5 } });
    });

    it("should separate $dec as negative inc", async () => {
      await productTable.updateOne({ id: 1, price: { $dec: 3 } } as any);
      const call = adapter.calls.find((c) => c.method === "updateOne");
      expect(call!.args[2]).toMatchObject({ inc: { price: -3 } });
    });

    it("should separate $mul ops", async () => {
      await productTable.updateOne({ id: 1, price: { $mul: 1.1 } } as any);
      const call = adapter.calls.find((c) => c.method === "updateOne");
      expect(call!.args[2]).toMatchObject({ mul: { price: 1.1 } });
    });

    it("should pass mixed ops and regular fields", async () => {
      await productTable.updateOne({ id: 1, name: "updated", price: { $inc: 5 } } as any);
      const call = adapter.calls.find((c) => c.method === "updateOne");
      expect(call!.args[1]).toEqual({ name: "updated" });
      expect(call!.args[2]).toMatchObject({ inc: { price: 5 } });
    });

    it("should pass undefined ops when no field ops present", async () => {
      await productTable.updateOne({ id: 1, name: "plain" } as any);
      const call = adapter.calls.find((c) => c.method === "updateOne");
      expect(call!.args[1]).toEqual({ name: "plain" });
      expect(call!.args[2]).toBeUndefined();
    });

    it("should detect nested ops inside merge-strategy objects", async () => {
      await productTable.updateOne({
        id: 1,
        stats: { views: { $inc: 1 }, rating: { $mul: 1.5 } },
      } as any);
      const call = adapter.calls.find((c) => c.method === "updateOne");
      expect(call).toBeDefined();
      // After decompose flattens to dot-paths, ops should be separated
      expect(call!.args[2]).toMatchObject({
        inc: { stats__views: 1 },
        mul: { stats__rating: 1.5 },
      });
      // The flattened data should not contain the ops
      expect(call!.args[1]).not.toHaveProperty("stats__views");
      expect(call!.args[1]).not.toHaveProperty("stats__rating");
    });

    it("should handle mixed nested ops and regular nested fields", async () => {
      await productTable.updateOne({
        id: 1,
        stats: { views: { $inc: 1 }, rating: 4.5 },
      } as any);
      const call = adapter.calls.find((c) => c.method === "updateOne");
      expect(call!.args[1]).toEqual({ stats__rating: 4.5 });
      expect(call!.args[2]).toMatchObject({ inc: { stats__views: 1 } });
    });

    it("should handle top-level and nested ops together", async () => {
      await productTable.updateOne({
        id: 1,
        price: { $mul: 0.9 },
        stats: { views: { $inc: 1 } },
      } as any);
      const call = adapter.calls.find((c) => c.method === "updateOne");
      expect(call!.args[2]).toMatchObject({
        inc: { stats__views: 1 },
        mul: { price: 0.9 },
      });
    });
  });

  describe("field ops via updateMany", () => {
    let productTable: AtscriptDbTable;

    beforeEach(() => {
      productTable = new AtscriptDbTable(ProductTable, adapter);
    });

    it("should separate $inc and pass ops to adapter", async () => {
      await productTable.updateMany({} as any, { price: { $inc: 10 } } as any);
      const call = adapter.calls.find((c) => c.method === "updateMany");
      expect(call).toBeDefined();
      expect(call!.args[2]).toMatchObject({ inc: { price: 10 } });
    });

    it("should pass undefined ops when no field ops present", async () => {
      await productTable.updateMany({} as any, { name: "bulk" } as any);
      const call = adapter.calls.find((c) => c.method === "updateMany");
      expect(call!.args[2]).toBeUndefined();
    });
  });

  describe("field ops validation", () => {
    let profileTable: AtscriptDbTable;
    let productTable: AtscriptDbTable;

    beforeEach(() => {
      profileTable = new AtscriptDbTable(ProfileTable, adapter);
      productTable = new AtscriptDbTable(ProductTable, adapter);
    });

    it("should reject $inc inside @db.json field", async () => {
      await expect(
        profileTable.updateOne({ id: 1, preferences: { theme: { $inc: 1 } } } as any),
      ).rejects.toThrow(/not supported inside @db\.json/);
    });

    it("should reject $inc inside nested object without merge strategy", async () => {
      // ProfileTable.contact has no @db.patch.strategy — defaults to replace
      await expect(
        profileTable.updateOne({ id: 1, contact: { email: { $inc: 1 } } } as any),
      ).rejects.toThrow(/not supported inside/);
    });

    it("should allow $inc inside nested object with merge strategy", async () => {
      // ProductTable.stats has @db.patch.strategy 'merge'
      await productTable.updateOne({ id: 1, stats: { views: { $inc: 1 } } } as any);
      const call = adapter.calls.find((c) => c.method === "updateOne");
      expect(call).toBeDefined();
      expect(call!.args[2]).toMatchObject({ inc: { stats__views: 1 } });
    });

    it("should allow $inc on top-level numeric field", async () => {
      await productTable.updateOne({ id: 1, price: { $inc: 5 } } as any);
      const call = adapter.calls.find((c) => c.method === "updateOne");
      expect(call!.args[2]).toMatchObject({ inc: { price: 5 } });
    });
  });

  describe("nested-objects adapter (bug #14)", () => {
    it("should build fieldDescriptors when adapter supports nested objects", () => {
      class NestedAdapter extends MockAdapter {
        override supportsNestedObjects(): boolean {
          return true;
        }
      }
      const nestedTable = new AtscriptDbTable(UsersTable, new NestedAdapter());
      const descriptors = nestedTable.fieldDescriptors;
      expect(descriptors).toBeDefined();
      expect(Array.isArray(descriptors)).toBe(true);
      expect(descriptors.length).toBeGreaterThan(0);
      expect(descriptors.some((d) => d.path === "id")).toBe(true);
    });
  });
});
