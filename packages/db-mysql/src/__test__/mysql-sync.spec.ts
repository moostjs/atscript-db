import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";
import type { TColumnDiff, TDbFieldMeta } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import type { TMysqlDriver, TMysqlConnection, TMysqlRunResult } from "../types";

import { prepareFixtures } from "./test-utils";

// ── Configurable mock driver ────────────────────────────────────────────────

interface CapturedCall {
  method: string;
  sql: string;
  params?: unknown[];
}

function createSyncMockDriver(opts?: {
  allResults?: Map<string, unknown[]>;
}): TMysqlDriver & { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const allResults = opts?.allResults ?? new Map();

  return {
    calls,
    async run(sql: string, params?: unknown[]): Promise<TMysqlRunResult> {
      calls.push({ method: "run", sql, params });
      return { affectedRows: 0, insertId: 0, changedRows: 0 };
    },
    async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
      calls.push({ method: "all", sql, params });
      // Match by prefix to return canned results
      for (const [key, val] of allResults) {
        if (sql.includes(key)) {
          return val as T[];
        }
      }
      return [] as T[];
    },
    async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
      calls.push({ method: "get", sql, params });
      return null as T | null;
    },
    async exec(sql: string): Promise<void> {
      calls.push({ method: "exec", sql });
    },
    async getConnection(): Promise<TMysqlConnection> {
      const connCalls: CapturedCall[] = [];
      return {
        async run(sql: string, params?: unknown[]) {
          connCalls.push({ method: "run", sql, params });
          calls.push({ method: "run", sql, params });
          return { affectedRows: 0, insertId: 0, changedRows: 0 };
        },
        async all<T>(sql: string, params?: unknown[]) {
          connCalls.push({ method: "all", sql, params });
          calls.push({ method: "all", sql, params });
          return [] as T[];
        },
        async get<T>(sql: string, params?: unknown[]) {
          connCalls.push({ method: "get", sql, params });
          calls.push({ method: "get", sql, params });
          return null as T | null;
        },
        async exec(sql: string) {
          connCalls.push({ method: "exec", sql });
          calls.push({ method: "exec", sql });
        },
        release: vi.fn(),
      };
    },
    async close() {},
  };
}

let UsersTable: any;

describe("MysqlAdapter — schema sync", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/test-table.as");
    UsersTable = fixtures.UsersTable;
  });

  // ── getExistingColumns ─────────────────────────────────────────────────

  describe("getExistingColumns", () => {
    it("should query INFORMATION_SCHEMA.COLUMNS", async () => {
      const cannedColumns = [
        {
          COLUMN_NAME: "id",
          COLUMN_TYPE: "int",
          IS_NULLABLE: "NO",
          COLUMN_KEY: "PRI",
          COLUMN_DEFAULT: null,
        },
        {
          COLUMN_NAME: "name",
          COLUMN_TYPE: "text",
          IS_NULLABLE: "NO",
          COLUMN_KEY: "",
          COLUMN_DEFAULT: null,
        },
      ];
      const driver = createSyncMockDriver({
        allResults: new Map([["INFORMATION_SCHEMA.COLUMNS", cannedColumns]]),
      });
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(UsersTable, adapter);

      const cols = await adapter.getExistingColumns();
      expect(cols).toEqual([
        { name: "id", type: "INT", notnull: true, pk: true, dflt_value: undefined },
        { name: "name", type: "TEXT", notnull: true, pk: false, dflt_value: undefined },
      ]);
    });

    it("should normalize CURRENT_TIMESTAMP to fn:now", async () => {
      const cannedColumns = [
        {
          COLUMN_NAME: "created_at",
          COLUMN_TYPE: "timestamp",
          IS_NULLABLE: "YES",
          COLUMN_KEY: "",
          COLUMN_DEFAULT: "CURRENT_TIMESTAMP",
        },
      ];
      const driver = createSyncMockDriver({
        allResults: new Map([["INFORMATION_SCHEMA.COLUMNS", cannedColumns]]),
      });
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(UsersTable, adapter);

      const cols = await adapter.getExistingColumns();
      expect(cols[0].dflt_value).toBe("fn:now");
    });

    it("should normalize uuid() to fn:uuid", async () => {
      const cannedColumns = [
        {
          COLUMN_NAME: "id",
          COLUMN_TYPE: "varchar(255)",
          IS_NULLABLE: "NO",
          COLUMN_KEY: "PRI",
          COLUMN_DEFAULT: "uuid()",
        },
      ];
      const driver = createSyncMockDriver({
        allResults: new Map([["INFORMATION_SCHEMA.COLUMNS", cannedColumns]]),
      });
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(UsersTable, adapter);

      const cols = await adapter.getExistingColumns();
      expect(cols[0].dflt_value).toBe("fn:uuid");
    });

    it("should strip enclosing single quotes from string defaults", async () => {
      const cannedColumns = [
        {
          COLUMN_NAME: "status",
          COLUMN_TYPE: "varchar(255)",
          IS_NULLABLE: "NO",
          COLUMN_KEY: "",
          COLUMN_DEFAULT: "'active'",
        },
      ];
      const driver = createSyncMockDriver({
        allResults: new Map([["INFORMATION_SCHEMA.COLUMNS", cannedColumns]]),
      });
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(UsersTable, adapter);

      const cols = await adapter.getExistingColumns();
      expect(cols[0].dflt_value).toBe("active");

      const allCall = driver.calls.find((c) => c.sql.includes("INFORMATION_SCHEMA"));
      expect(allCall).toBeDefined();
      expect(allCall!.params).toEqual(["users", "auth"]);
    });
  });

  // ── syncColumns ────────────────────────────────────────────────────────

  describe("syncColumns", () => {
    it("should emit ALTER TABLE ADD COLUMN for new fields", async () => {
      const driver = createSyncMockDriver();
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(UsersTable, adapter);

      const diff: TColumnDiff = {
        added: [
          {
            physicalName: "age",
            designType: "integer",
            optional: false,
            isPrimaryKey: false,
          } as TDbFieldMeta,
        ],
        removed: [],
        renamed: [],
        typeChanged: [],
        nullableChanged: [],
        defaultChanged: [],
        conflicts: [],
      };

      const result = await adapter.syncColumns(diff);
      const addCall = driver.calls.find((c) => c.sql.includes("ADD COLUMN"));
      expect(addCall).toBeDefined();
      expect(addCall!.sql).toContain("`age`");
      expect(addCall!.sql).toContain("INT");
      expect(addCall!.sql).toContain("NOT NULL");
      expect(addCall!.sql).toContain("DEFAULT 0"); // defaultValueForType('integer')
      expect(result.added).toContain("age");
    });

    it("should emit ALTER TABLE RENAME COLUMN for renamed fields", async () => {
      const driver = createSyncMockDriver();
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(UsersTable, adapter);

      const diff: TColumnDiff = {
        added: [],
        removed: [],
        renamed: [
          {
            field: {
              physicalName: "full_name",
              designType: "string",
              optional: false,
            } as TDbFieldMeta,
            oldName: "name",
          },
        ],
        typeChanged: [],
        nullableChanged: [],
        defaultChanged: [],
        conflicts: [],
      };

      const result = await adapter.syncColumns(diff);
      const renameCall = driver.calls.find((c) => c.sql.includes("RENAME COLUMN"));
      expect(renameCall).toBeDefined();
      expect(renameCall!.sql).toContain("`name`");
      expect(renameCall!.sql).toContain("`full_name`");
      expect(result.renamed).toContain("full_name");
    });

    it("should emit ALTER TABLE MODIFY COLUMN for type changes", async () => {
      const driver = createSyncMockDriver();
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(UsersTable, adapter);

      const diff: TColumnDiff = {
        added: [],
        removed: [],
        renamed: [],
        typeChanged: [
          {
            field: {
              physicalName: "score",
              designType: "number",
              optional: false,
              isPrimaryKey: false,
            } as TDbFieldMeta,
            existingType: "INT",
          },
        ],
        nullableChanged: [],
        defaultChanged: [],
        conflicts: [],
      };

      await adapter.syncColumns(diff);
      const modifyCall = driver.calls.find((c) => c.sql.includes("MODIFY COLUMN"));
      expect(modifyCall).toBeDefined();
      expect(modifyCall!.sql).toContain("`score`");
      expect(modifyCall!.sql).toContain("DOUBLE");
      expect(modifyCall!.sql).toContain("NOT NULL");
    });

    it("should emit ALTER TABLE MODIFY COLUMN for nullable changes", async () => {
      const driver = createSyncMockDriver();
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(UsersTable, adapter);

      const diff: TColumnDiff = {
        added: [],
        removed: [],
        renamed: [],
        typeChanged: [],
        nullableChanged: [
          {
            field: { physicalName: "bio", designType: "string", optional: true } as TDbFieldMeta,
            wasNullable: false,
          },
        ],
        defaultChanged: [],
        conflicts: [],
      };

      await adapter.syncColumns(diff);
      const modifyCall = driver.calls.find((c) => c.sql.includes("MODIFY COLUMN"));
      expect(modifyCall).toBeDefined();
      expect(modifyCall!.sql).toContain("`bio`");
      expect(modifyCall!.sql).toContain("NULL");
      expect(modifyCall!.sql).not.toContain("NOT NULL");
    });
  });

  // ── dropColumns ────────────────────────────────────────────────────────

  describe("dropColumns", () => {
    it("should emit multi-column DROP in a single ALTER TABLE", async () => {
      const driver = createSyncMockDriver();
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(UsersTable, adapter);

      await adapter.dropColumns(["col_a", "col_b", "col_c"]);
      const dropCall = driver.calls.find((c) => c.sql.includes("DROP COLUMN"))!;
      // All three columns in a single ALTER TABLE statement
      expect(dropCall.sql).toContain("DROP COLUMN `col_a`");
      expect(dropCall.sql).toContain("DROP COLUMN `col_b`");
      expect(dropCall.sql).toContain("DROP COLUMN `col_c`");
      // Single statement, not three separate ones
      const dropCalls = driver.calls.filter((c) => c.sql.includes("DROP COLUMN"));
      expect(dropCalls.length).toBe(1);
    });
  });

  // ── recreateTable ──────────────────────────────────────────────────────

  describe("recreateTable", () => {
    it("should disable FK checks during recreation", async () => {
      const cannedColumns = [
        {
          COLUMN_NAME: "id",
          COLUMN_TYPE: "int",
          IS_NULLABLE: "NO",
          COLUMN_KEY: "PRI",
          COLUMN_DEFAULT: null,
        },
      ];
      const driver = createSyncMockDriver({
        allResults: new Map([["INFORMATION_SCHEMA.COLUMNS", cannedColumns]]),
      });
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(UsersTable, adapter);

      await adapter.recreateTable();

      const sqls = driver.calls.map((c) => c.sql);
      expect(sqls.some((s) => s.includes("FOREIGN_KEY_CHECKS = 0"))).toBe(true);
      expect(sqls.some((s) => s.includes("FOREIGN_KEY_CHECKS = 1"))).toBe(true);
    });

    it("should create temp table, copy data, drop old, rename", async () => {
      const cannedColumns = [
        {
          COLUMN_NAME: "id",
          COLUMN_TYPE: "int",
          IS_NULLABLE: "NO",
          COLUMN_KEY: "PRI",
          COLUMN_DEFAULT: null,
        },
        {
          COLUMN_NAME: "name",
          COLUMN_TYPE: "text",
          IS_NULLABLE: "NO",
          COLUMN_KEY: "",
          COLUMN_DEFAULT: null,
        },
      ];
      const driver = createSyncMockDriver({
        allResults: new Map([["INFORMATION_SCHEMA.COLUMNS", cannedColumns]]),
      });
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(UsersTable, adapter);

      await adapter.recreateTable();

      const sqls = driver.calls.map((c) => c.sql);
      // Should create temp table
      expect(
        sqls.some((s) => s.includes("CREATE TABLE IF NOT EXISTS") && s.includes("__tmp_")),
      ).toBe(true);
      // Should copy data
      expect(sqls.some((s) => s.includes("INSERT INTO") && s.includes("SELECT"))).toBe(true);
      // Should drop old table
      expect(sqls.some((s) => s.includes("DROP TABLE IF EXISTS"))).toBe(true);
      // Should rename temp to original
      expect(sqls.some((s) => s.includes("RENAME TABLE"))).toBe(true);
    });
  });

  // ── syncIndexes ────────────────────────────────────────────────────────

  describe("syncIndexes", () => {
    it("should query INFORMATION_SCHEMA.STATISTICS for existing indexes", async () => {
      const driver = createSyncMockDriver();
      const adapter = new MysqlAdapter(driver);
      const table = new AtscriptDbTable(UsersTable, adapter);

      await table.syncIndexes();
      const statsCall = driver.calls.find((c) => c.sql.includes("INFORMATION_SCHEMA.STATISTICS"));
      expect(statsCall).toBeDefined();
    });

    it("should emit CREATE INDEX for missing indexes", async () => {
      const driver = createSyncMockDriver({
        allResults: new Map([["INFORMATION_SCHEMA.STATISTICS", []]]),
      });
      const adapter = new MysqlAdapter(driver);
      const table = new AtscriptDbTable(UsersTable, adapter);

      await table.syncIndexes();
      const createCalls = driver.calls.filter(
        (c) => c.sql.includes("CREATE") && c.sql.includes("INDEX"),
      );
      expect(createCalls.length).toBeGreaterThan(0);
    });

    it("should emit CREATE UNIQUE INDEX for unique indexes", async () => {
      const driver = createSyncMockDriver({
        allResults: new Map([["INFORMATION_SCHEMA.STATISTICS", []]]),
      });
      const adapter = new MysqlAdapter(driver);
      const table = new AtscriptDbTable(UsersTable, adapter);

      await table.syncIndexes();
      const uniqueCall = driver.calls.find((c) => c.sql.includes("UNIQUE INDEX"));
      expect(uniqueCall).toBeDefined();
      expect(uniqueCall!.sql).toContain("email_idx");
    });

    it("should add key length prefix (255) for string columns in non-fulltext indexes", async () => {
      const driver = createSyncMockDriver({
        allResults: new Map([["INFORMATION_SCHEMA.STATISTICS", []]]),
      });
      const adapter = new MysqlAdapter(driver);
      const table = new AtscriptDbTable(UsersTable, adapter);

      await table.syncIndexes();
      // email is string + unique index → should have (255) prefix
      const uniqueCall = driver.calls.find((c) => c.sql.includes("UNIQUE INDEX"));
      expect(uniqueCall!.sql).toContain("`email_address`(255)");
      // name is string + plain index → should have (255) prefix
      const plainCall = driver.calls.find(
        (c) => c.sql.includes("CREATE INDEX") && c.sql.includes("name_idx"),
      );
      expect(plainCall!.sql).toContain("`name`(255)");
    });

    it("should NOT add key length prefix or explicit ordering for fulltext indexes", async () => {
      const driver = createSyncMockDriver({
        allResults: new Map([["INFORMATION_SCHEMA.STATISTICS", []]]),
      });
      const adapter = new MysqlAdapter(driver);
      const table = new AtscriptDbTable(UsersTable, adapter);

      await table.syncIndexes();
      const fulltextCall = driver.calls.find((c) => c.sql.includes("FULLTEXT INDEX"));
      expect(fulltextCall).toBeDefined();
      expect(fulltextCall!.sql).toContain("search_idx");
      expect(fulltextCall!.sql).not.toContain("(255)");
      expect(fulltextCall!.sql).not.toMatch(/\bASC\b/);
      expect(fulltextCall!.sql).not.toMatch(/\bDESC\b/);
    });

    it("should skip existing indexes", async () => {
      const existingIndexes = [
        { name: "atscript__unique__email_idx" },
        { name: "atscript__plain__name_idx" },
        { name: "atscript__plain__created_idx" },
        { name: "atscript__fulltext__search_idx" },
      ];
      const driver = createSyncMockDriver({
        allResults: new Map([["INFORMATION_SCHEMA.STATISTICS", existingIndexes]]),
      });
      const adapter = new MysqlAdapter(driver);
      const table = new AtscriptDbTable(UsersTable, adapter);

      await table.syncIndexes();
      const createCalls = driver.calls.filter(
        (c) => c.sql.includes("CREATE") && c.sql.includes("INDEX"),
      );
      expect(createCalls.length).toBe(0);
    });
  });

  // ── syncForeignKeys ────────────────────────────────────────────────────

  describe("syncForeignKeys", () => {
    let FkFixtures: any;

    beforeAll(async () => {
      FkFixtures = await import("./fixtures/fk-tables.as");
    });

    it("should query INFORMATION_SCHEMA.KEY_COLUMN_USAGE for existing FKs", async () => {
      const driver = createSyncMockDriver();
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(FkFixtures.Task, adapter);

      await adapter.syncForeignKeys();
      const kcu = driver.calls.find((c) => c.sql.includes("KEY_COLUMN_USAGE"));
      expect(kcu).toBeDefined();
    });

    it("should emit ALTER TABLE ADD FOREIGN KEY for missing FKs", async () => {
      const driver = createSyncMockDriver({
        allResults: new Map([["KEY_COLUMN_USAGE", []]]),
      });
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(FkFixtures.Task, adapter);

      await adapter.syncForeignKeys();
      const addFk = driver.calls.filter((c) => c.sql.includes("ADD FOREIGN KEY"));
      expect(addFk.length).toBeGreaterThan(0);
    });

    it("should emit ALTER TABLE DROP FOREIGN KEY for stale FKs", async () => {
      const existingFks = [
        {
          CONSTRAINT_NAME: "fk_old",
          COLUMN_NAME: "old_col",
          REFERENCED_TABLE_NAME: "other",
          REFERENCED_COLUMN_NAME: "id",
        },
      ];
      const driver = createSyncMockDriver({
        allResults: new Map([["KEY_COLUMN_USAGE", existingFks]]),
      });
      const adapter = new MysqlAdapter(driver);
      new AtscriptDbTable(FkFixtures.Task, adapter);

      await adapter.syncForeignKeys();
      const dropFk = driver.calls.find((c) => c.sql.includes("DROP FOREIGN KEY"));
      expect(dropFk).toBeDefined();
      expect(dropFk!.sql).toContain("`fk_old`");
    });
  });
});
