import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

let UsersTable: any;

describe("SQLite getExistingColumns + syncColumns", () => {
  let driver: BetterSqlite3Driver;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/test-table.as");
    UsersTable = fixtures.UsersTable;
  });

  beforeEach(() => {
    driver = new BetterSqlite3Driver(":memory:");
  });

  afterEach(() => {
    driver.close();
  });

  describe("getExistingColumns", () => {
    it("should return column info from PRAGMA", async () => {
      const adapter = new SqliteAdapter(driver);
      const space = new DbSpace(() => adapter);
      const table = space.getTable(UsersTable);
      await table.ensureTable();

      const cols = await adapter.getExistingColumns();
      expect(cols.length).toBeGreaterThan(0);

      const idCol = cols.find((c) => c.name === "id");
      expect(idCol).toBeDefined();
      expect(idCol!.pk).toBe(true);

      const nameCol = cols.find((c) => c.name === "name");
      expect(nameCol).toBeDefined();
      expect(nameCol!.type).toBe("TEXT");
    });

    it("should return empty array for non-existent table", async () => {
      const adapter = new SqliteAdapter(driver);
      const space = new DbSpace(() => adapter);
      space.getTable(UsersTable);
      // Don't create the table — PRAGMA returns empty for non-existent
      const cols = await adapter.getExistingColumns();
      expect(cols.length).toBe(0);
    });
  });

  describe("syncColumns", () => {
    it("should add new columns via ALTER TABLE", async () => {
      // Create a minimal table
      driver.exec('CREATE TABLE "users" ("id" INTEGER PRIMARY KEY)');

      const adapter = new SqliteAdapter(driver);
      const space = new DbSpace(() => adapter);
      const table = space.getTable(UsersTable);

      // Manually build a diff with one added field
      const diff = {
        added: table.fieldDescriptors.filter((f: any) => !f.ignored && f.physicalName !== "id"),
        removed: [],
        renamed: [],
        typeChanged: [],
        nullableChanged: [],
        defaultChanged: [],
        conflicts: [],
      };

      const result = await adapter.syncColumns(diff);
      expect(result.added.length).toBeGreaterThan(0);

      // Verify via PRAGMA
      const cols = await adapter.getExistingColumns();
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("name");
      expect(colNames).toContain("email_address");
    });

    it("should handle NOT NULL columns with defaults", async () => {
      driver.exec('CREATE TABLE "users" ("id" INTEGER PRIMARY KEY)');

      const adapter = new SqliteAdapter(driver);
      const space = new DbSpace(() => adapter);
      const table = space.getTable(UsersTable);

      const diff = {
        added: table.fieldDescriptors.filter((f: any) => !f.ignored && f.physicalName !== "id"),
        removed: [],
        renamed: [],
        typeChanged: [],
        nullableChanged: [],
        defaultChanged: [],
        conflicts: [],
      };

      // Should not throw
      await adapter.syncColumns(diff);

      // Insert and read back
      await table.insertOne({
        name: "Test",
        email: "test@example.com",
        createdAt: Date.now(),
        status: "active",
      });

      const rows = await table.findMany({ filter: {}, controls: {} });
      expect(rows.length).toBe(1);
    });
  });
});
