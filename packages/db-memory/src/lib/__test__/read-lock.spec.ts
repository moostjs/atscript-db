import type { AtscriptDbTable, DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures, user } from "./test-utils";

let User: any;

/**
 * Locking reads + isolation on the memory adapter (since 0.1.162): accepted
 * and ignored inside a `withTransaction` scope (a pass-through one here);
 * outside a scope a lock still fails loudly.
 */
describe("MemoryAdapter — locking reads and isolation", () => {
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
    await users.insertMany([user({ id: "a" }), user({ id: "b" })] as any);
  });

  it("accepts and ignores a lock inside withTransaction", async () => {
    const adapter = users.getAdapter();
    const rows = await adapter.withTransaction(() =>
      users.findMany(
        { filter: {}, controls: { $sort: { id: 1 } } },
        { lock: "update", wait: "skipLocked" },
      ),
    );
    expect((rows as any[]).map((r) => r.id)).toEqual(["a", "b"]);
    const one = await adapter.withTransaction(() => users.findById("a", { lock: "share" }));
    expect(one).toMatchObject({ id: "a" });
  });

  it("rejects a lock outside a transaction scope", async () => {
    await expect(
      users.findOne({ filter: { id: "a" }, controls: {} }, { lock: "update" }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("accepts and ignores every isolation level", async () => {
    const adapter = users.getAdapter();
    for (const isolation of ["read committed", "repeatable read", "serializable"] as const) {
      await expect(
        adapter.withTransaction(
          () => adapter.withTransaction(async () => 1, { isolation: "serializable" }),
          { isolation },
        ),
      ).resolves.toBe(1);
    }
  });
});
