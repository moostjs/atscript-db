import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

// Populated by beforeAll after fixtures are compiled
let UsersTable: any;
let NoTableAnnotation: any;
let ProfileTable: any;

describe("SqliteAdapter + AtscriptDbTable", () => {
  let driver: BetterSqlite3Driver;
  let adapter: SqliteAdapter;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/test-table.as");
    UsersTable = fixtures.UsersTable;
    NoTableAnnotation = fixtures.NoTableAnnotation;
    ProfileTable = fixtures.ProfileTable;
  });

  beforeEach(() => {
    driver = new BetterSqlite3Driver(":memory:");
    adapter = new SqliteAdapter(driver);
    table = new AtscriptDbTable(UsersTable, adapter);
  });

  afterEach(() => {
    driver.close();
  });

  // ── Schema operations ──────────────────────────────────────────────────

  describe("ensureTable", () => {
    it("should create the table", async () => {
      await table.ensureTable();

      // Verify table exists via PRAGMA
      const tables = driver.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='users'`,
      );
      expect(tables.length).toBe(1);
    });

    it("should create columns matching the type definition", async () => {
      await table.ensureTable();

      const columns = driver.all<{ name: string; type: string; notnull: number }>(
        `PRAGMA table_info("users")`,
      );
      const colNames = columns.map((c) => c.name);

      // Physical column name for email is "email_address" (from @db.column)
      expect(colNames).toContain("id");
      expect(colNames).toContain("email_address");
      expect(colNames).toContain("name");
      expect(colNames).toContain("createdAt");
      expect(colNames).toContain("status");
      expect(colNames).toContain("bio");

      // displayName should NOT exist (@db.ignore)
      expect(colNames).not.toContain("displayName");
    });

    it("should set the primary key", async () => {
      await table.ensureTable();

      const columns = driver.all<{ name: string; pk: number }>(`PRAGMA table_info("users")`);
      const pkCol = columns.find((c) => c.pk === 1);
      expect(pkCol?.name).toBe("id");
    });

    it("should be idempotent", async () => {
      await table.ensureTable();
      await table.ensureTable(); // should not throw
    });
  });

  describe("syncIndexes", () => {
    it("should create indexes from @db.index annotations", async () => {
      await table.ensureTable();
      await table.syncIndexes();

      const indexes = driver.all<{ name: string }>(`PRAGMA index_list("users")`);
      const indexNames = indexes.map((i) => i.name);

      // Index names use the full key format: atscript__<type>__<name>
      expect(indexNames).toContain("atscript__unique__email_idx");
      expect(indexNames).toContain("atscript__plain__name_idx");
      expect(indexNames).toContain("atscript__plain__created_idx");
      // fulltext indexes are skipped for basic SQLite
    });

    it("should create unique indexes for @db.index.unique", async () => {
      await table.ensureTable();
      await table.syncIndexes();

      const indexes = driver.all<{ name: string; unique: number }>(`PRAGMA index_list("users")`);
      const emailIdx = indexes.find((i) => i.name === "atscript__unique__email_idx");
      expect(emailIdx?.unique).toBe(1);
    });

    it("should be idempotent", async () => {
      await table.ensureTable();
      await table.syncIndexes();
      await table.syncIndexes(); // should not throw or duplicate
    });
  });

  // ── CRUD operations ────────────────────────────────────────────────────

  describe("insertOne", () => {
    beforeEach(async () => {
      await table.ensureTable();
    });

    it("should insert a record and return the ID", async () => {
      const result = await table.insertOne({
        id: 1,
        email: "john@example.com",
        name: "John",
        createdAt: 1000,
        status: "active",
      } as any);
      expect(result.insertedId).toBeDefined();
    });

    it("should apply column mapping (@db.column)", async () => {
      await table.insertOne({
        id: 1,
        email: "john@example.com",
        name: "John",
        createdAt: 1000,
        status: "active",
      } as any);

      // Read raw row — email should be stored as email_address
      const row = driver.get(`SELECT * FROM users WHERE id = 1`);
      expect(row?.email_address).toBe("john@example.com");
      expect(row?.email).toBeUndefined();
    });

    it("should strip ignored fields (@db.ignore)", async () => {
      await table.insertOne({
        id: 1,
        email: "john@example.com",
        name: "John",
        createdAt: 1000,
        status: "active",
        displayName: "Johnny",
      } as any);

      const row = driver.get(`SELECT * FROM users WHERE id = 1`);
      expect(row?.displayName).toBeUndefined();
    });

    it("should apply default values (@db.default)", async () => {
      await table.insertOne({
        id: 1,
        email: "john@example.com",
        name: "John",
        createdAt: 1000,
      } as any);

      const row = driver.get(`SELECT * FROM users WHERE id = 1`);
      expect(row?.status).toBe("active");
    });
  });

  describe("insertMany", () => {
    beforeEach(async () => {
      await table.ensureTable();
    });

    it("should insert multiple records in a transaction", async () => {
      const result = await table.insertMany([
        { id: 1, email: "a@example.com", name: "A", createdAt: 1000, status: "active" },
        { id: 2, email: "b@example.com", name: "B", createdAt: 2000, status: "active" },
      ] as any[]);

      expect(result.insertedCount).toBe(2);

      const count = await table.count();
      expect(count).toBe(2);
    });
  });

  describe("findOne", () => {
    beforeEach(async () => {
      await table.ensureTable();
      await table.insertOne({
        id: 1,
        email: "john@example.com",
        name: "John",
        createdAt: 1000,
        status: "active",
      } as any);
    });

    it("should find a record by filter", async () => {
      const result = await table.findOne({ filter: { id: 1 }, controls: {} });
      expect(result).not.toBeNull();
      expect((result as any).name).toBe("John");
    });

    it("should return null when not found", async () => {
      const result = await table.findOne({ filter: { id: 999 }, controls: {} });
      expect(result).toBeNull();
    });
  });

  describe("findMany", () => {
    beforeEach(async () => {
      await table.ensureTable();
      await table.insertMany([
        { id: 1, email: "a@x.com", name: "Alice", createdAt: 1000, status: "active" },
        { id: 2, email: "b@x.com", name: "Bob", createdAt: 2000, status: "inactive" },
        { id: 3, email: "c@x.com", name: "Charlie", createdAt: 3000, status: "active" },
      ] as any[]);
    });

    it("should find records matching filter", async () => {
      const results = await table.findMany({ filter: { status: "active" }, controls: {} });
      expect(results.length).toBe(2);
    });

    it("should respect limit option", async () => {
      const results = await table.findMany({ filter: {}, controls: { $limit: 2 } });
      expect(results.length).toBe(2);
    });

    it("should respect skip option", async () => {
      const results = await table.findMany({ filter: {}, controls: { $limit: 2, $skip: 1 } });
      expect(results.length).toBe(2);
    });

    it("should respect sort option", async () => {
      const results = await table.findMany({ filter: {}, controls: { $sort: { createdAt: -1 } } });
      expect((results[0] as any).name).toBe("Charlie");
      expect((results[2] as any).name).toBe("Alice");
    });

    it("should handle $or filter", async () => {
      const results = await table.findMany({
        filter: { $or: [{ name: "Alice" }, { name: "Charlie" }] },
        controls: {},
      });
      expect(results.length).toBe(2);
    });

    it("should handle $gt filter", async () => {
      const results = await table.findMany({ filter: { createdAt: { $gt: 1500 } }, controls: {} });
      expect(results.length).toBe(2);
    });

    it("should handle $in filter", async () => {
      const results = await table.findMany({
        filter: { name: { $in: ["Alice", "Bob"] } },
        controls: {},
      });
      expect(results.length).toBe(2);
    });
  });

  describe("count", () => {
    beforeEach(async () => {
      await table.ensureTable();
      await table.insertMany([
        { id: 1, email: "a@x.com", name: "Alice", createdAt: 1000, status: "active" },
        { id: 2, email: "b@x.com", name: "Bob", createdAt: 2000, status: "active" },
        { id: 3, email: "c@x.com", name: "Charlie", createdAt: 3000, status: "inactive" },
      ] as any[]);
    });

    it("should count all records", async () => {
      expect(await table.count()).toBe(3);
    });

    it("should count records matching filter", async () => {
      expect(await table.count({ filter: { status: "active" }, controls: {} })).toBe(2);
    });
  });

  describe("updateMany", () => {
    beforeEach(async () => {
      await table.ensureTable();
      await table.insertMany([
        { id: 1, email: "a@x.com", name: "Alice", createdAt: 1000, status: "active" },
        { id: 2, email: "b@x.com", name: "Bob", createdAt: 2000, status: "active" },
      ] as any[]);
    });

    it("should update matching records", async () => {
      const result = await table.updateMany({ status: "active" }, { status: "suspended" });
      expect(result.modifiedCount).toBe(2);

      const rows = await table.findMany({ filter: { status: "suspended" }, controls: {} });
      expect(rows.length).toBe(2);
    });
  });

  describe("deleteOne", () => {
    beforeEach(async () => {
      await table.ensureTable();
      await table.insertOne({
        id: 1,
        email: "john@example.com",
        name: "John",
        createdAt: 1000,
        status: "active",
      } as any);
    });

    it("should delete a record by primary key", async () => {
      const result = await table.deleteOne(1);
      expect(result.deletedCount).toBe(1);

      const row = await table.findOne({ filter: { id: 1 }, controls: {} });
      expect(row).toBeNull();
    });
  });

  describe("deleteMany", () => {
    beforeEach(async () => {
      await table.ensureTable();
      await table.insertMany([
        { id: 1, email: "a@x.com", name: "Alice", createdAt: 1000, status: "inactive" },
        { id: 2, email: "b@x.com", name: "Bob", createdAt: 2000, status: "inactive" },
        { id: 3, email: "c@x.com", name: "Charlie", createdAt: 3000, status: "active" },
      ] as any[]);
    });

    it("should delete matching records", async () => {
      const result = await table.deleteMany({ status: "inactive" });
      expect(result.deletedCount).toBe(2);

      const count = await table.count();
      expect(count).toBe(1);
    });
  });

  // ── Driver swappability ────────────────────────────────────────────────

  describe("driver swappability", () => {
    it("should work with a custom TSqliteDriver implementation", async () => {
      // Create a minimal mock driver that wraps BetterSqlite3Driver
      const innerDriver = new BetterSqlite3Driver(":memory:");
      const calls: string[] = [];

      const customDriver = {
        run(sql: string, params?: unknown[]) {
          calls.push(`run: ${sql.slice(0, 30)}`);
          return innerDriver.run(sql, params);
        },
        all<T>(sql: string, params?: unknown[]): T[] {
          calls.push(`all: ${sql.slice(0, 30)}`);
          return innerDriver.all<T>(sql, params);
        },
        get<T>(sql: string, params?: unknown[]): T | null {
          calls.push(`get: ${sql.slice(0, 30)}`);
          return innerDriver.get<T>(sql, params);
        },
        exec(sql: string) {
          calls.push(`exec: ${sql.slice(0, 30)}`);
          return innerDriver.exec(sql);
        },
        close() {
          calls.push("close");
          innerDriver.close();
        },
      };

      const customAdapter = new SqliteAdapter(customDriver);
      const customTable = new AtscriptDbTable(UsersTable, customAdapter);

      await customTable.ensureTable();
      await customTable.insertOne({
        id: 1,
        email: "test@example.com",
        name: "Test",
        createdAt: 1000,
        status: "active",
      } as any);

      const result = await customTable.findOne({ filter: { id: 1 }, controls: {} });
      expect(result).not.toBeNull();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.some((c) => c.startsWith("exec:"))).toBe(true);
      expect(calls.some((c) => c.startsWith("run:"))).toBe(true);
      expect(calls.some((c) => c.startsWith("get:"))).toBe(true);

      customDriver.close();
    });
  });

  // ── NoTableAnnotation fallback ─────────────────────────────────────────

  describe("NoTableAnnotation fallback", () => {
    it("should use interface name when @db.table is missing", () => {
      const d = new BetterSqlite3Driver(":memory:");
      const a = new SqliteAdapter(d);
      const t = new AtscriptDbTable(NoTableAnnotation, a);
      expect(t.tableName).toBe("NoTableAnnotation");
      d.close();
    });
  });
});

// ── Embedded Objects Integration ──────────────────────────────────────────

describe("SqliteAdapter — embedded objects", () => {
  let driver: BetterSqlite3Driver;
  let adapter: SqliteAdapter;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
  });

  beforeEach(async () => {
    driver = new BetterSqlite3Driver(":memory:");
    adapter = new SqliteAdapter(driver);
    table = new AtscriptDbTable(ProfileTable, adapter);
    await table.ensureTable();
  });

  afterEach(() => {
    driver.close();
  });

  describe("ensureTable", () => {
    it("should create __-separated columns for flattened fields", () => {
      const columns = driver.all<{ name: string }>(`PRAGMA table_info("profiles")`);
      const colNames = columns.map((c) => c.name);

      expect(colNames).toContain("contact__email");
      expect(colNames).toContain("contact__phone");
      expect(colNames).toContain("settings__notifications__email");
      expect(colNames).toContain("settings__notifications__sms");
      // Parent object should NOT be a column
      expect(colNames).not.toContain("contact");
      expect(colNames).not.toContain("settings");
      expect(colNames).not.toContain("settings__notifications");
    });

    it("should create a single column for @db.json fields", () => {
      const columns = driver.all<{ name: string }>(`PRAGMA table_info("profiles")`);
      const colNames = columns.map((c) => c.name);

      expect(colNames).toContain("preferences");
      expect(colNames).toContain("tags");
    });

    it("should exclude @db.ignore fields", () => {
      const columns = driver.all<{ name: string }>(`PRAGMA table_info("profiles")`);
      const colNames = columns.map((c) => c.name);
      expect(colNames).not.toContain("displayName");
    });
  });

  describe("insert + findOne round-trip", () => {
    it("should preserve nested object structure through insert and read", async () => {
      await table.insertOne({
        id: 1,
        name: "Alice",
        contact: { email: "alice@x.com", phone: "555-0100" },
        preferences: { theme: "dark", lang: "en" },
        tags: ["admin", "user"],
        settings: { notifications: { email: true, sms: false } },
      } as any);

      const result = (await table.findOne({ filter: { id: 1 }, controls: {} })) as any;

      expect(result.name).toBe("Alice");
      expect(result.contact).toEqual({ email: "alice@x.com", phone: "555-0100" });
      expect(result.preferences).toEqual({ theme: "dark", lang: "en" });
      expect(result.tags).toEqual(["admin", "user"]);
      expect(result.settings).toEqual({ notifications: { email: true, sms: false } });
    });

    it("should handle omitted optional fields within nested objects", async () => {
      await table.insertOne({
        id: 1,
        name: "Bob",
        contact: { email: "bob@x.com" },
        preferences: { theme: "light", lang: "en" },
        tags: [],
        settings: { notifications: { email: false, sms: false } },
      } as any);

      const result = (await table.findOne({ filter: { id: 1 }, controls: {} })) as any;

      expect(result.name).toBe("Bob");
      expect(result.contact.email).toBe("bob@x.com");
      // phone was omitted — stored as NULL, reconstructed as null
      expect(result.contact.phone).toBeNull();
    });

    it("should store @db.json fields as JSON TEXT in the database", async () => {
      await table.insertOne({
        id: 1,
        name: "Carol",
        contact: { email: "carol@x.com" },
        preferences: { theme: "light", lang: "fr" },
        tags: ["viewer"],
        settings: { notifications: { email: true, sms: true } },
      } as any);

      // Read the raw row to verify JSON storage
      const raw = driver.get(`SELECT preferences, tags FROM profiles WHERE id = 1`);
      expect(typeof raw?.preferences).toBe("string");
      expect(JSON.parse(raw?.preferences as string)).toEqual({ theme: "light", lang: "fr" });
      expect(typeof raw?.tags).toBe("string");
      expect(JSON.parse(raw?.tags as string)).toEqual(["viewer"]);
    });
  });

  describe("query by nested path", () => {
    beforeEach(async () => {
      await table.insertMany([
        {
          id: 1,
          name: "Alice",
          contact: { email: "alice@x.com", phone: "111" },
          preferences: { theme: "dark", lang: "en" },
          tags: [],
          settings: { notifications: { email: true, sms: false } },
        },
        {
          id: 2,
          name: "Bob",
          contact: { email: "bob@x.com", phone: "222" },
          preferences: { theme: "light", lang: "en" },
          tags: [],
          settings: { notifications: { email: false, sms: true } },
        },
        {
          id: 3,
          name: "Carol",
          contact: { email: "carol@x.com", phone: "333" },
          preferences: { theme: "dark", lang: "fr" },
          tags: [],
          settings: { notifications: { email: true, sms: true } },
        },
      ] as any[]);
    });

    it("should filter by dot-notation nested path", async () => {
      const results = await table.findMany({
        filter: { "contact.email": "alice@x.com" },
        controls: {},
      } as any);
      expect(results.length).toBe(1);
      expect((results[0] as any).name).toBe("Alice");
    });

    it("should filter by deep nested path", async () => {
      const results = await table.findMany({
        filter: { "settings.notifications.email": true },
        controls: {},
      } as any);
      expect(results.length).toBe(2);
    });

    it("should sort by nested path", async () => {
      const results = await table.findMany({
        filter: {},
        controls: { $sort: { "contact.phone": -1 } },
      } as any);
      expect((results[0] as any).name).toBe("Carol");
      expect((results[2] as any).name).toBe("Alice");
    });
  });
});

// ── Transaction support ───────────────────────────────────────────────────

describe("SqliteAdapter — transactions", () => {
  let driver: BetterSqlite3Driver;
  let adapter: SqliteAdapter;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
  });

  beforeEach(async () => {
    const fixtures = await import("./fixtures/test-table.as");
    driver = new BetterSqlite3Driver(":memory:");
    adapter = new SqliteAdapter(driver);
    table = new AtscriptDbTable(fixtures.UsersTable as any, adapter);
    await table.ensureTable();
    await table.syncIndexes();
  });

  afterEach(() => {
    driver.close();
  });

  it("should nest withTransaction calls without double-BEGIN", async () => {
    const adapter2 = new SqliteAdapter(driver);
    const fixtures = await import("./fixtures/test-table.as");
    const table2 = new AtscriptDbTable(fixtures.UsersTable as any, adapter2);

    const result = await adapter.withTransaction(async () => {
      await table.insertOne({
        name: "User A",
        email: "a@test.com",
        createdAt: 1000,
        status: "active",
      } as any);
      await adapter2.withTransaction(async () => {
        await table2.insertOne({
          name: "User B",
          email: "b@test.com",
          createdAt: 1000,
          status: "active",
        } as any);
      });
      return "done";
    });

    expect(result).toBe("done");
    const count = await table.count({ filter: {}, controls: {} });
    expect(count).toBe(2);
  });

  it("should rollback all records on error", async () => {
    await table.insertOne({
      name: "Existing",
      email: "exists@test.com",
      createdAt: 1000,
      status: "active",
    } as any);

    try {
      await adapter.withTransaction(async () => {
        await table.insertOne({
          name: "Will rollback",
          email: "rollback@test.com",
          createdAt: 1000,
          status: "active",
        } as any);
        throw new Error("Intentional failure");
      });
    } catch {
      // expected
    }

    const count = await table.count({ filter: {}, controls: {} });
    expect(count).toBe(1);
  });

  it("should commit on success", async () => {
    await adapter.withTransaction(async () => {
      await table.insertOne({
        name: "Committed",
        email: "committed@test.com",
        createdAt: 1000,
        status: "active",
      } as any);
    });

    const count = await table.count({ filter: {}, controls: {} });
    expect(count).toBe(1);
  });
});
