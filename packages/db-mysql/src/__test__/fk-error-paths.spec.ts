import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { AtscriptDbTable, DbError } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import type { TMysqlDriver, TMysqlConnection } from "../types";

import { prepareFixtures } from "./test-utils";

function createErrorDriver(error: unknown): TMysqlDriver {
  return {
    async run() {
      throw error;
    },
    async all<T>() {
      return [] as T[];
    },
    async get<T>() {
      return null as T;
    },
    async exec() {},
    async getConnection(): Promise<TMysqlConnection> {
      return {
        async run() {
          throw error;
        },
        async all<T>() {
          return [] as T[];
        },
        async get<T>() {
          return null as T;
        },
        async exec() {},
        release: vi.fn(),
      };
    },
    async close() {},
  };
}

let TaskType: any;
let ProjectType: any;

describe("MysqlAdapter — FK error mapping", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/fk-tables.as");
    TaskType = fixtures.Task;
    ProjectType = fixtures.Project;
  });

  it("should extract FK column from error message and map to field path", async () => {
    const err = Object.assign(new Error("FK violation"), {
      errno: 1452,
      sqlMessage:
        "Cannot add or update a child row: a foreign key constraint fails (`db`.`tasks`, CONSTRAINT `tasks_ibfk_1` FOREIGN KEY (`projectId`) REFERENCES `projects` (`id`))",
      message:
        "Cannot add or update a child row: a foreign key constraint fails (`db`.`tasks`, CONSTRAINT `tasks_ibfk_1` FOREIGN KEY (`projectId`) REFERENCES `projects` (`id`))",
    });

    const driver = createErrorDriver(err);
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(TaskType, adapter);

    try {
      await table.insertOne({ id: 1, title: "Test", projectId: 999 } as any);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DbError);
      const dbErr = error as DbError;
      expect(dbErr.code).toBe("FK_VIOLATION");
      // Should extract 'projectId' from the FOREIGN KEY (`projectId`) pattern
      expect(dbErr.errors[0].path).toBe("projectId");
    }
  });

  it("should remap FK error on delete (errno 1451) to CONFLICT via _remapDeleteFkViolation", async () => {
    // When a delete triggers a FK violation (RESTRICT), the table layer
    // remaps FK_VIOLATION → CONFLICT because it's always a RESTRICT constraint.
    const err = Object.assign(new Error("FK violation"), {
      errno: 1451,
      sqlMessage:
        "Cannot delete or update a parent row: a foreign key constraint fails (`db`.`tasks`, CONSTRAINT `tasks_ibfk_1` FOREIGN KEY (`projectId`) REFERENCES `projects` (`id`))",
      message:
        "Cannot delete or update a parent row: a foreign key constraint fails (`db`.`tasks`, CONSTRAINT `tasks_ibfk_1` FOREIGN KEY (`projectId`) REFERENCES `projects` (`id`))",
    });

    const driver = createErrorDriver(err);
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(ProjectType, adapter);

    try {
      await table.deleteOne(1);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DbError);
      const dbErr = error as DbError;
      // Table layer remaps FK_VIOLATION → CONFLICT on delete
      expect(dbErr.code).toBe("CONFLICT");
    }
  });

  it("should extract field name from duplicate key error (errno 1062)", async () => {
    const err = Object.assign(new Error("Duplicate"), {
      errno: 1062,
      sqlMessage: "Duplicate entry 'foo@bar.com' for key 'tasks.PRIMARY'",
      message: "Duplicate entry 'foo@bar.com' for key 'tasks.PRIMARY'",
    });

    const driver = createErrorDriver(err);
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(TaskType, adapter);

    try {
      await table.insertOne({ id: 1, title: "Test", projectId: 1 } as any);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DbError);
      const dbErr = error as DbError;
      expect(dbErr.code).toBe("CONFLICT");
      expect(dbErr.errors[0].path).toBe("PRIMARY");
    }
  });

  it("should use physical column when FK column has no logical mapping", async () => {
    const err = Object.assign(new Error("FK violation"), {
      errno: 1452,
      sqlMessage: "Cannot add: FOREIGN KEY (`unknown_col`) REFERENCES `other` (`id`)",
      message: "Cannot add: FOREIGN KEY (`unknown_col`) REFERENCES `other` (`id`)",
    });

    const driver = createErrorDriver(err);
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(TaskType, adapter);

    try {
      await table.insertOne({ id: 1, title: "Test", projectId: 1 } as any);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DbError);
      const dbErr = error as DbError;
      expect(dbErr.code).toBe("FK_VIOLATION");
      // Falls back to physical column name when no mapping found
      expect(dbErr.errors[0].path).toBe("unknown_col");
    }
  });

  it("should enrich empty-path FK errors with FK field names from metadata", async () => {
    // When the adapter can't extract a field from the error message,
    // the table layer's _enrichFkViolation fills in all FK field names.
    const err = Object.assign(new Error("FK violation"), {
      errno: 1452,
      sqlMessage: "A foreign key constraint fails (unrecognizable format)",
      message: "A foreign key constraint fails (unrecognizable format)",
    });

    const driver = createErrorDriver(err);
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(TaskType, adapter);

    try {
      await table.insertOne({ id: 1, title: "Test", projectId: 1 } as any);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DbError);
      const dbErr = error as DbError;
      expect(dbErr.code).toBe("FK_VIOLATION");
      // Table layer enriches empty-path errors with all FK fields from metadata
      const paths = dbErr.errors.map((err) => err.path);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.some((p) => p === "projectId" || p === "reviewerId")).toBe(true);
    }
  });

  it("should pass through non-constraint errors unchanged", async () => {
    const err = new Error("Connection lost");
    const driver = createErrorDriver(err);
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(TaskType, adapter);

    await expect(table.insertOne({ id: 1, title: "Test", projectId: 1 } as any)).rejects.toThrow(
      "Connection lost",
    );
  });
});
