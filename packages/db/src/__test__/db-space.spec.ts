import { describe, it, expect, vi, beforeAll } from "vite-plus/test";
import type { FilterExpr } from "@uniqu/core";

import { DbSpace } from "../table/db-space";
import { BaseDbAdapter } from "../base-adapter";
import type {
  DbQuery,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbDeleteResult,
} from "../types";

import { prepareFixtures } from "./test-utils";

let UsersTable: any;
let ProfileTable: any;

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

  async updateOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    this.record("updateOne", filter, data);
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

  async updateMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    this.record("updateMany", filter, data);
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

describe("DbSpace", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/test-table.as");
    UsersTable = fixtures.UsersTable;
    ProfileTable = fixtures.ProfileTable;
  });

  it("should create tables lazily via getTable", () => {
    const factory = vi.fn(() => new MockAdapter());
    const space = new DbSpace(factory);

    // No adapters created yet
    expect(factory).not.toHaveBeenCalled();

    const table = space.getTable(UsersTable);
    expect(table).toBeDefined();
    expect(table.tableName).toBe("users");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("should cache tables — same type returns same instance", () => {
    const factory = vi.fn(() => new MockAdapter());
    const space = new DbSpace(factory);

    const t1 = space.getTable(UsersTable);
    const t2 = space.getTable(UsersTable);

    expect(t1).toBe(t2);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("should create separate adapters for different types", () => {
    const factory = vi.fn(() => new MockAdapter());
    const space = new DbSpace(factory);

    const users = space.getTable(UsersTable);
    const profiles = space.getTable(ProfileTable);

    expect(users).not.toBe(profiles);
    expect(users.tableName).toBe("users");
    expect(profiles.tableName).toBe("profiles");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("should return adapter via getAdapter", () => {
    const space = new DbSpace(() => new MockAdapter());

    const adapter = space.getAdapter(UsersTable);
    expect(adapter).toBeInstanceOf(MockAdapter);
  });

  it("should wire table resolver so tables can discover each other", () => {
    const space = new DbSpace(() => new MockAdapter());

    const users = space.getTable(UsersTable);
    space.getTable(ProfileTable);

    // Access internals to verify resolver is wired
    const resolver = (users as any)._tableResolver;
    expect(resolver).toBeDefined();

    // Resolver should return the profiles table
    const resolved = resolver(ProfileTable);
    expect(resolved).toBeDefined();
    expect(resolved.primaryKeys).toBeDefined();
  });

  it("should pass custom logger to tables", () => {
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const space = new DbSpace(() => new MockAdapter(), logger as any);

    const table = space.getTable(UsersTable);
    // Access internal logger
    expect((table as any).logger).toBe(logger);
  });
});
