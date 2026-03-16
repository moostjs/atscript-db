import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable, DbError } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

let Task: any;

describe("FK error paths use logical field names", () => {
  let driver: BetterSqlite3Driver;
  let taskAdapter: SqliteAdapter;
  let taskTable: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/fk-tables.as");
    Task = fixtures.Task;
  });

  beforeEach(() => {
    driver = new BetterSqlite3Driver(":memory:");

    // Create tables with native FK constraints manually
    // (the compiled .as.js doesn't carry target refs for @db.rel.FK)
    driver.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    driver.exec(`CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      projectId INTEGER NOT NULL REFERENCES projects(id),
      reviewerId INTEGER REFERENCES projects(id)
    )`);

    taskAdapter = new SqliteAdapter(driver);
    taskTable = new AtscriptDbTable(Task, taskAdapter);
  });

  afterEach(() => {
    driver.close();
  });

  it("should report logical field names (not __auto_ prefixed) on FK violation", async () => {
    try {
      await taskTable.insertOne({ id: 1, title: "test", projectId: 999 });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DbError);
      const err = error as DbError;
      expect(err.code).toBe("FK_VIOLATION");
      // Error paths must use logical field names, not internal __auto_ map keys
      const paths = err.errors.map((e) => e.path);
      for (const p of paths) {
        expect(p).not.toMatch(/^__auto_/);
      }
      expect(paths).toContain("projectId");
    }
  });

  it("should include all FK fields in the error", async () => {
    try {
      await taskTable.insertOne({ id: 1, title: "test", projectId: 999 });
      expect.unreachable("Should have thrown");
    } catch (error) {
      const err = error as DbError;
      const paths = err.errors.map((e) => e.path);
      // Both FK fields should be reported (projectId and reviewerId)
      expect(paths).toContain("projectId");
      expect(paths).toContain("reviewerId");
    }
  });
});
