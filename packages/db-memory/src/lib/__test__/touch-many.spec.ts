import { DbError } from "@atscript/db";
import type { AtscriptDbTable, DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures, user } from "./test-utils";

let User: any;

/**
 * `touchMany` on the memory adapter (since 0.1.129): `withTransaction` is a
 * passthrough here, so the pre-count is what keeps a stale batch from moving
 * any version.
 */
describe("MemoryAdapter touchMany", () => {
  let space: DbSpace;
  let users: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    User = (await import("./fixtures/stored.as")).User;
  });

  beforeEach(async () => {
    space = createTestSpace();
    users = space.getTable(User);
    await bootstrapStoredTables(space, [User]);
    await users.insertMany([user({ id: "a" }), user({ id: "b" }), user({ id: "c" })] as any);
    await users.updateOne({ id: "c", age: 30 } as any); // version 1
  });

  const versions = async () =>
    ((await users.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[]).map(
      (r) => r.version,
    );

  it("full match bumps every version by exactly 1", async () => {
    const result = await users.touchMany([
      { id: "a", version: 0 },
      { id: "b", version: 0 },
      { id: "c", version: 1 },
    ] as any);
    expect(result).toEqual({ matchedCount: 3, modifiedCount: 3 });
    expect(await versions()).toEqual([1, 1, 2]);
  });

  it("one stale key → CAS_MISMATCH, no version moves", async () => {
    const err = await users
      .touchMany([
        { id: "a", version: 0 },
        { id: "b", version: 3 },
        { id: "c", version: 1 },
      ] as any)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("CAS_MISMATCH");
    expect(await versions()).toEqual([0, 0, 1]);
  });

  it("require: 'any' → partial bump, honest counts", async () => {
    const result = await users.touchMany(
      [
        { id: "a", version: 0 },
        { id: "b", version: 3 },
      ] as any,
      { require: "any" },
    );
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    expect(await versions()).toEqual([1, 0, 1]);
  });
});
