import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { DbError } from "../db-error";
import { DbSpace } from "../table/db-space";
import { prepareFixtures, MockAdapter } from "./test-utils";

let UserType: any;
let ProjectType: any;
let CategoryType: any;

describe("RESTRICT delete", () => {
  let sharedStore: Map<string, Array<Record<string, unknown>>>;

  beforeAll(async () => {
    await prepareFixtures();
    const user = await import("./fixtures/restrict-user.as");
    const project = await import("./fixtures/restrict-project.as");
    const category = await import("./fixtures/restrict-category.as");
    UserType = user.User;
    ProjectType = project.Project;
    CategoryType = category.Category;
  });

  beforeEach(() => {
    sharedStore = new Map();
  });

  function createSpace() {
    return new DbSpace(() => {
      const adapter = new MockAdapter();
      adapter.store = sharedStore;
      return adapter;
    });
  }

  function seedData() {
    sharedStore.set("users", [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    sharedStore.set("projects", [
      { id: 10, title: "Project A", ownerId: 1 },
      { id: 20, title: "Project B", ownerId: 1 },
      { id: 30, title: "Project C", ownerId: 2 },
    ]);
    sharedStore.set("categories", [
      { id: 100, label: "Cat X", ownerId: 1 },
      { id: 200, label: "Cat Y", ownerId: 2 },
    ]);
  }

  // ── Bug 07: RESTRICT should throw CONFLICT (not FK_VIOLATION) ─────────

  it("should throw DbError CONFLICT when RESTRICT blocks a delete", async () => {
    const space = createSpace();
    const users = space.getTable(UserType);
    space.getTable(ProjectType);
    space.getTable(CategoryType);
    seedData();

    // User 2 has a category with RESTRICT — delete should be blocked
    const err = await users.deleteOne(2).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("CONFLICT");
  });

  // ── Bug 08: RESTRICT error should mention child table and field ───────

  it("should include child table and field in RESTRICT error message", async () => {
    const space = createSpace();
    const users = space.getTable(UserType);
    space.getTable(ProjectType);
    space.getTable(CategoryType);
    seedData();

    const err = (await users.deleteOne(2).catch((error: unknown) => error)) as DbError;
    expect(err.message).toMatch(/categories/);
    expect(err.message).toMatch(/ownerId/);
    expect(err.message).toMatch(/RESTRICT/i);
  });

  // ── Bug 09: RESTRICT pre-check before CASCADE ────────────────────────

  it("should check RESTRICT before executing CASCADE (no data loss)", async () => {
    const space = createSpace();
    const users = space.getTable(UserType);
    space.getTable(ProjectType);
    space.getTable(CategoryType);
    seedData();

    // User 1 has projects (cascade) AND categories (restrict).
    // Delete should be blocked by RESTRICT before any cascade happens.
    const err = await users.deleteOne(1).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("CONFLICT");

    // Projects must still exist — cascade should NOT have run
    expect(sharedStore.get("projects")!.map((p) => p.id)).toEqual([10, 20, 30]);
    // Categories untouched
    expect(sharedStore.get("categories")!.map((c) => c.id)).toEqual([100, 200]);
    // User 1 still exists
    expect(sharedStore.get("users")!.map((u) => u.id)).toEqual([1, 2]);
  });

  it("should allow delete when no RESTRICT children exist", async () => {
    const space = createSpace();
    const users = space.getTable(UserType);
    space.getTable(ProjectType);
    space.getTable(CategoryType);
    seedData();

    // Remove all categories for user 1 so RESTRICT passes
    sharedStore.set("categories", [{ id: 200, label: "Cat Y", ownerId: 2 }]);

    await users.deleteOne(1);

    // User 1 deleted, projects cascaded
    expect(sharedStore.get("users")!.map((u) => u.id)).toEqual([2]);
    expect(sharedStore.get("projects")!.map((p) => p.id)).toEqual([30]);
  });

  // ── Bug 07: Native FK adapter remaps FK_VIOLATION to CONFLICT ─────────

  it("should remap native FK_VIOLATION to CONFLICT on delete", async () => {
    const nativeStore = new Map<string, Array<Record<string, unknown>>>();
    const space = new DbSpace(() => {
      const adapter = new MockAdapter();
      adapter.store = nativeStore;
      adapter.supportsNativeForeignKeys = () => true;
      // Simulate native RESTRICT: deleteOne throws FK_VIOLATION
      adapter.deleteOne = async (_filter) => {
        // Simulate native RESTRICT error on the first call
        throw new DbError("FK_VIOLATION", [{ path: "", message: "FOREIGN KEY constraint failed" }]);
      };
      return adapter;
    });

    const users = space.getTable(UserType);
    space.getTable(ProjectType);
    space.getTable(CategoryType);

    nativeStore.set("users", [{ id: 1, name: "Alice" }]);

    const err = (await users.deleteOne(1).catch((error: unknown) => error)) as DbError;
    expect(err).toBeInstanceOf(DbError);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toMatch(/RESTRICT/);
    expect(err.message).toMatch(/users/);
  });
});
