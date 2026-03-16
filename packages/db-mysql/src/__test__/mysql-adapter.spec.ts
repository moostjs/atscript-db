import { describe, it, expect, beforeAll, beforeEach, vi } from "vite-plus/test";
import { AtscriptDbTable, DbError } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

// ── Tests ────────────────────────────────────────────────────────────────────

let UsersTable: any;
let ProfileTable: any;
let NoTableAnnotation: any;

describe("MysqlAdapter + AtscriptDbTable", () => {
  let driver: ReturnType<typeof createMockDriver>;
  let adapter: MysqlAdapter;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/test-table.as");
    UsersTable = fixtures.UsersTable;
    ProfileTable = fixtures.ProfileTable;
    NoTableAnnotation = fixtures.NoTableAnnotation;
  });

  beforeEach(() => {
    driver = createMockDriver();
    adapter = new MysqlAdapter(driver);
    table = new AtscriptDbTable(UsersTable, adapter);
  });

  // ── Schema operations ──────────────────────────────────────────────────

  describe("ensureTable", () => {
    it("should emit CREATE TABLE IF NOT EXISTS", async () => {
      await table.ensureTable();
      const execCall = driver.calls.find(
        (c) => c.method === "exec" && c.sql.includes("CREATE TABLE"),
      );
      expect(execCall).toBeDefined();
      expect(execCall!.sql).toContain("CREATE TABLE IF NOT EXISTS");
      expect(execCall!.sql).toContain("`users`");
    });

    it("should include ENGINE, CHARSET, COLLATE defaults", async () => {
      await table.ensureTable();
      const execCall = driver.calls.find((c) => c.sql.includes("CREATE TABLE"))!;
      expect(execCall.sql).toContain("ENGINE=InnoDB");
      expect(execCall.sql).toContain("DEFAULT CHARSET=utf8mb4");
      expect(execCall.sql).toContain("COLLATE=utf8mb4_unicode_ci");
    });

    it("should use backtick-quoted column names", async () => {
      await table.ensureTable();
      const execCall = driver.calls.find((c) => c.sql.includes("CREATE TABLE"))!;
      expect(execCall.sql).toContain("`id`");
      expect(execCall.sql).toContain("`email_address`");
      expect(execCall.sql).toContain("`name`");
    });

    it("should set PRIMARY KEY on id column", async () => {
      await table.ensureTable();
      const execCall = driver.calls.find((c) => c.sql.includes("CREATE TABLE"))!;
      expect(execCall.sql).toContain("PRIMARY KEY");
    });

    it("should include NOT NULL for required columns", async () => {
      await table.ensureTable();
      const sql = driver.calls.find((c) => c.sql.includes("CREATE TABLE"))!.sql;
      expect(sql).toContain("`name` TEXT NOT NULL");
    });

    it("should set DEFAULT for @db.default fields", async () => {
      await table.ensureTable();
      const sql = driver.calls.find((c) => c.sql.includes("CREATE TABLE"))!.sql;
      expect(sql).toContain("DEFAULT 'active'");
    });

    it("should set DEFAULT CURRENT_TIMESTAMP for @db.default.now fields", async () => {
      await table.ensureTable();
      const sql = driver.calls.find((c) => c.sql.includes("CREATE TABLE"))!.sql;
      expect(sql).toContain("DEFAULT CURRENT_TIMESTAMP");
    });

    it("should not include @db.ignore columns", async () => {
      await table.ensureTable();
      const sql = driver.calls.find((c) => c.sql.includes("CREATE TABLE"))!.sql;
      expect(sql).not.toContain("`displayName`");
    });
  });

  describe("ensureTable — AUTO_INCREMENT", () => {
    it("should include AUTO_INCREMENT for @db.default.increment fields", async () => {
      const profileDriver = createMockDriver();
      const profileAdapter = new MysqlAdapter(profileDriver);
      const profileTable = new AtscriptDbTable(ProfileTable, profileAdapter);
      await profileTable.ensureTable();

      const sql = profileDriver.calls.find((c) => c.sql.includes("CREATE TABLE"))!.sql;
      expect(sql).toContain("AUTO_INCREMENT");
    });
  });

  // ── CRUD: Insert ────────────────────────────────────────────────────────
  // Note: table.insertOne() wraps in withTransaction(), so all SQL
  // goes through the connection. Both pool and connection calls are
  // captured in the unified driver.calls array.

  describe("insertOne", () => {
    it("should emit INSERT INTO with backtick-quoted columns", async () => {
      await table.insertOne({
        id: 1,
        email: "test@x.com",
        name: "Test",
        createdAt: 1000,
        status: "active",
      } as any);
      const runCall = driver.calls.find((c) => c.method === "run" && c.sql.includes("INSERT INTO"));
      expect(runCall).toBeDefined();
      expect(runCall!.sql).toContain("`users`");
      expect(runCall!.sql).toContain("VALUES");
    });

    it("should return insertedId from data when @meta.id is present", async () => {
      const result = await table.insertOne({
        id: 42,
        email: "test@x.com",
        name: "Test",
        createdAt: 1000,
        status: "active",
      } as any);
      expect(result.insertedId).toBe(42);
    });

    it("should fall back to db-generated insertId when no PK in data", async () => {
      const d = createMockDriver({ runResult: { insertId: 999 } });
      const a = new MysqlAdapter(d);
      const t = new AtscriptDbTable(UsersTable, a);
      const result = await t.insertOne({
        email: "x@x.com",
        name: "X",
        createdAt: 1000,
        status: "ok",
      } as any);
      expect(result.insertedId).toBe(999);
    });

    it("should use physical column names (@db.column)", async () => {
      await table.insertOne({
        id: 1,
        email: "test@x.com",
        name: "Test",
        createdAt: 1000,
        status: "active",
      } as any);
      const runCall = driver.calls.find(
        (c) => c.method === "run" && c.sql.includes("INSERT INTO"),
      )!;
      expect(runCall.sql).toContain("`email_address`");
      expect(runCall.sql).not.toContain("`email`");
    });
  });

  describe("insertMany", () => {
    it("should run in a transaction", async () => {
      await table.insertMany([
        { id: 1, email: "a@x.com", name: "A", createdAt: 1000, status: "active" },
        { id: 2, email: "b@x.com", name: "B", createdAt: 2000, status: "active" },
      ] as any[]);
      expect(driver.calls.some((c) => c.sql === "START TRANSACTION")).toBe(true);
      expect(driver.calls.some((c) => c.sql === "COMMIT")).toBe(true);
    });

    it("should batch rows into a single multi-row INSERT", async () => {
      await table.insertMany([
        { id: 1, email: "a@x.com", name: "A", createdAt: 1000, status: "active" },
        { id: 2, email: "b@x.com", name: "B", createdAt: 2000, status: "active" },
      ] as any[]);
      const inserts = driver.calls.filter((c) => c.sql.includes("INSERT INTO"));
      expect(inserts.length).toBe(1);
      // Multi-row VALUES
      expect(inserts[0].sql).toContain("), (");
    });
  });

  // ── CRUD: Read ──────────────────────────────────────────────────────────

  describe("findOne", () => {
    it("should emit SELECT with LIMIT 1", async () => {
      await table.findOne({ filter: { id: 1 }, controls: {} });
      const getCall = driver.calls.find((c) => c.method === "get" && c.sql.includes("SELECT"));
      expect(getCall).toBeDefined();
      expect(getCall!.sql).toContain("LIMIT ?");
      expect(getCall!.params).toContain(1);
    });

    it("should use backtick-quoted table name", async () => {
      await table.findOne({ filter: { id: 1 }, controls: {} });
      const getCall = driver.calls.find((c) => c.method === "get")!;
      expect(getCall.sql).toContain("`users`");
    });
  });

  describe("findMany", () => {
    it("should emit SELECT with WHERE clause", async () => {
      await table.findMany({ filter: { status: "active" }, controls: {} });
      const allCall = driver.calls.find((c) => c.method === "all" && c.sql.includes("SELECT"));
      expect(allCall).toBeDefined();
      expect(allCall!.sql).toContain("SELECT");
      expect(allCall!.sql).toContain("WHERE");
    });

    it("should include ORDER BY for $sort", async () => {
      await table.findMany({ filter: {}, controls: { $sort: { name: 1 } } });
      const allCall = driver.calls.find((c) => c.method === "all" && c.sql.includes("SELECT"))!;
      expect(allCall.sql).toContain("ORDER BY");
    });

    it("should include LIMIT and OFFSET", async () => {
      await table.findMany({ filter: {}, controls: { $limit: 10, $skip: 5 } });
      const allCall = driver.calls.find((c) => c.method === "all" && c.sql.includes("SELECT"))!;
      expect(allCall.sql).toContain("LIMIT ?");
      expect(allCall.sql).toContain("OFFSET ?");
      expect(allCall.params).toContain(10);
      expect(allCall.params).toContain(5);
    });
  });

  describe("count", () => {
    it("should emit SELECT COUNT(*)", async () => {
      driver = createMockDriver({ getResult: { cnt: 5 } });
      adapter = new MysqlAdapter(driver);
      table = new AtscriptDbTable(UsersTable, adapter);

      const result = await table.count();
      const getCall = driver.calls.find((c) => c.method === "get" && c.sql.includes("COUNT"))!;
      expect(getCall.sql).toContain("SELECT COUNT(*) as cnt");
      expect(result).toBe(5);
    });
  });

  // ── CRUD: Update ────────────────────────────────────────────────────────

  describe("updateOne (adapter-level)", () => {
    it("should emit UPDATE with LIMIT 1", async () => {
      // updateOne is an adapter method (table uses patchById/bulkUpdate)
      await adapter.updateOne({ id: 1 }, { name: "Updated" });
      const runCall = driver.calls.find((c) => c.method === "run" && c.sql.includes("UPDATE"));
      expect(runCall).toBeDefined();
      expect(runCall!.sql).toContain("UPDATE");
      expect(runCall!.sql).toContain("LIMIT 1");
    });

    it("should return matchedCount and modifiedCount", async () => {
      driver = createMockDriver({ runResult: { affectedRows: 1, changedRows: 1, insertId: 0 } });
      adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(UsersTable, adapter); // register table
      const result = await adapter.updateOne({ id: 1 }, { name: "Updated" });
      expect(result.matchedCount).toBe(1);
      expect(result.modifiedCount).toBe(1);
    });
  });

  describe("updateMany", () => {
    it("should emit UPDATE without LIMIT", async () => {
      await table.updateMany({ status: "active" }, { status: "suspended" } as any);
      const runCall = driver.calls.find((c) => c.method === "run" && c.sql.includes("UPDATE"))!;
      expect(runCall.sql).not.toContain("LIMIT");
    });
  });

  // ── CRUD: Delete ────────────────────────────────────────────────────────

  describe("deleteOne", () => {
    it("should emit DELETE with LIMIT 1", async () => {
      await table.deleteOne(1);
      const runCall = driver.calls.find((c) => c.method === "run" && c.sql.includes("DELETE"));
      expect(runCall).toBeDefined();
      expect(runCall!.sql).toContain("DELETE FROM");
      expect(runCall!.sql).toContain("LIMIT 1");
    });
  });

  describe("deleteMany", () => {
    it("should emit DELETE without LIMIT", async () => {
      await table.deleteMany({ status: "inactive" });
      const runCall = driver.calls.find((c) => c.method === "run" && c.sql.includes("DELETE"))!;
      expect(runCall.sql).not.toContain("LIMIT");
    });
  });

  // ── Error mapping ──────────────────────────────────────────────────────

  describe("_wrapConstraintError", () => {
    it("should map errno 1062 to DbError CONFLICT", async () => {
      const err = Object.assign(new Error("Duplicate"), {
        errno: 1062,
        sqlMessage: "Duplicate entry 'foo' for key 'users.email_idx'",
        message: "Duplicate entry 'foo' for key 'users.email_idx'",
      });

      // Override both pool and connection run to throw
      const d = createMockDriver();
      const origGetConn = d.getConnection.bind(d);
      d.run = async () => {
        throw err;
      };
      d.getConnection = async () => {
        const conn = await origGetConn();
        conn.run = async () => {
          throw err;
        };
        return conn;
      };
      const a = new MysqlAdapter(d);
      const t = new AtscriptDbTable(UsersTable, a);

      try {
        await t.insertOne({ id: 1, email: "x", name: "X", createdAt: 1, status: "a" } as any);
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(DbError);
        expect((error as DbError).code).toBe("CONFLICT");
      }
    });

    it("should map errno 1452 to DbError FK_VIOLATION", async () => {
      const err = Object.assign(new Error("FK"), {
        errno: 1452,
        sqlMessage: "Cannot add or update: FOREIGN KEY (`projectId`) REFERENCES `projects`",
        message: "Cannot add or update: FOREIGN KEY (`projectId`) REFERENCES `projects`",
      });

      const d = createMockDriver();
      const origGetConn = d.getConnection.bind(d);
      d.run = async () => {
        throw err;
      };
      d.getConnection = async () => {
        const conn = await origGetConn();
        conn.run = async () => {
          throw err;
        };
        return conn;
      };
      const a = new MysqlAdapter(d);
      const t = new AtscriptDbTable(UsersTable, a);

      try {
        await t.insertOne({ id: 1, email: "x", name: "X", createdAt: 1, status: "a" } as any);
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(DbError);
        expect((error as DbError).code).toBe("FK_VIOLATION");
      }
    });

    it("should rethrow non-MySQL errors as-is", async () => {
      const err = new Error("Network failure");
      const d = createMockDriver();
      const origGetConn = d.getConnection.bind(d);
      d.run = async () => {
        throw err;
      };
      d.getConnection = async () => {
        const conn = await origGetConn();
        conn.run = async () => {
          throw err;
        };
        return conn;
      };
      const a = new MysqlAdapter(d);
      const t = new AtscriptDbTable(UsersTable, a);

      await expect(
        t.insertOne({ id: 1, email: "x", name: "X", createdAt: 1, status: "a" } as any),
      ).rejects.toThrow("Network failure");
    });
  });

  // ── Transaction flow ───────────────────────────────────────────────────

  describe("transactions", () => {
    it("should acquire connection and START TRANSACTION", async () => {
      await adapter.withTransaction(async () => {
        // no-op
      });
      expect(driver.calls.some((c) => c.sql === "START TRANSACTION")).toBe(true);
      expect(driver.calls.some((c) => c.sql === "COMMIT")).toBe(true);
    });

    it("should ROLLBACK on error", async () => {
      try {
        await adapter.withTransaction(async () => {
          throw new Error("Boom");
        });
      } catch {
        // expected
      }
      expect(driver.calls.some((c) => c.sql === "ROLLBACK")).toBe(true);
    });

    it("should release connection after COMMIT", async () => {
      const releaseSpy = vi.fn();
      const origGetConn = driver.getConnection.bind(driver);
      driver.getConnection = async () => {
        const conn = await origGetConn();
        conn.release = releaseSpy;
        return conn;
      };

      await adapter.withTransaction(async () => {});
      expect(releaseSpy).toHaveBeenCalled();
    });

    it("should release connection after ROLLBACK", async () => {
      const releaseSpy = vi.fn();
      const origGetConn = driver.getConnection.bind(driver);
      driver.getConnection = async () => {
        const conn = await origGetConn();
        conn.release = releaseSpy;
        return conn;
      };

      try {
        await adapter.withTransaction(async () => {
          throw new Error("Fail");
        });
      } catch {
        // expected
      }
      expect(releaseSpy).toHaveBeenCalled();
    });
  });

  // ── Capability flags ───────────────────────────────────────────────────

  describe("capability flags", () => {
    it("supportsNativeForeignKeys should return true", () => {
      expect(adapter.supportsNativeForeignKeys()).toBe(true);
    });
  });

  // ── Table name resolution ──────────────────────────────────────────────

  describe("table name", () => {
    it("should use @db.table annotation for table name", () => {
      expect(table.tableName).toBe("users");
    });

    it("should use @db.schema for schema prefix", () => {
      expect(table.schema).toBe("auth");
    });

    it("should fall back to interface name when @db.table is missing", () => {
      const d = createMockDriver();
      const a = new MysqlAdapter(d);
      const t = new AtscriptDbTable(NoTableAnnotation, a);
      expect(t.tableName).toBe("NoTableAnnotation");
    });
  });

  // ── Drop operations (adapter-level) ────────────────────────────────────

  describe("dropTable", () => {
    it("should emit DROP TABLE IF EXISTS", async () => {
      await adapter.dropTable();
      const execCall = driver.calls.find((c) => c.sql.includes("DROP TABLE"));
      expect(execCall).toBeDefined();
      expect(execCall!.sql).toContain("DROP TABLE IF EXISTS");
    });
  });

  describe("dropColumns", () => {
    it("should emit ALTER TABLE DROP COLUMN for each column", async () => {
      await adapter.dropColumns(["old_col", "another_col"]);
      const execCall = driver.calls.find((c) => c.sql.includes("DROP COLUMN"));
      expect(execCall).toBeDefined();
      expect(execCall!.sql).toContain("DROP COLUMN `old_col`");
      expect(execCall!.sql).toContain("DROP COLUMN `another_col`");
    });
  });

  describe("renameTable", () => {
    it("should emit RENAME TABLE", async () => {
      await adapter.renameTable("old_users");
      const execCall = driver.calls.find((c) => c.sql.includes("RENAME TABLE"));
      expect(execCall).toBeDefined();
      expect(execCall!.sql).toContain("`old_users`");
    });
  });
});
