import { BaseDbAdapter, DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { MemoryAdapter } from "../memory-adapter";
import { createTestSpace, prepareFixtures, user } from "./test-utils";

let User: any;
let Composite: any;
let Sequence: any;
let AdultUser: any;

// Since 0.1.137: tables live in the space's in-memory database (keyed by name),
// so schema sync really drops a removed table. Before, the memory adapter had
// no drop primitive, sync reported the drop anyway and the rows survived.
describe("MemoryAdapter — schema sync drops and existence", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const stored = await import("./fixtures/stored.as");
    User = stored.User;
    Composite = stored.Composite;
    Sequence = stored.Sequence;
    AdultUser = (await import("./fixtures/views.as")).AdultUser;
  });

  it("drops a removed table; added back it is reported `create` and starts empty", async () => {
    const db = createTestSpace();
    const sync = new SchemaSync(db);
    const first = await sync.run([User, Composite, Sequence], { force: true });
    expect(first.entries.find((e) => e.name === "users")?.status).toBe("create");

    await db.getTable(User).insertOne(user({ id: "u1" }));
    await db.getTable(Sequence).insertOne({ label: "a" });
    await db.getTable(Sequence).insertOne({ label: "b" });

    const removed = await sync.run([Composite], { force: true });
    expect(removed.status).toBe("synced");
    expect(removed.entries.find((e) => e.name === "users")?.status).toBe("drop");
    expect(removed.entries.find((e) => e.name === "sequences")?.status).toBe("drop");
    expect(await db.getAdapter(User).tableExists!()).toBe(false);
    expect(await db.getTable(User).count()).toBe(0);
    expect(await db.getAdapter(Composite).tableExists!()).toBe(true);

    const readded = await sync.run([User, Composite, Sequence], { force: true });
    expect(readded.entries.find((e) => e.name === "users")?.status).toBe("create");
    expect(readded.entries.find((e) => e.name === "composites")?.status).toBe("in-sync");
    expect(await db.getAdapter(User).tableExists!()).toBe(true);
    expect(await db.getTable(User).count()).toBe(0);
    // Unique indexes are re-recorded, the increment counter restarts
    await db.getTable(User).insertOne(user({ id: "u2", email: "same@x.com" }));
    await expect(
      db.getTable(User).insertOne(user({ id: "u3", email: "same@x.com" })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const seq = await db.getTable(Sequence).insertOne({ label: "c" });
    expect(seq.insertedId).toBe(1);
  });

  it("drops a removed view and recreates it", async () => {
    const db = createTestSpace();
    const sync = new SchemaSync(db);
    const first = await sync.run([User, AdultUser], { force: true });
    expect(first.entries.find((e) => e.name === "adult_users")?.status).toBe("create");
    expect(await db.getAdapter(AdultUser).tableExists!()).toBe(true);

    const removed = await sync.run([User], { force: true });
    expect(removed.entries.find((e) => e.name === "adult_users")?.status).toBe("drop");
    expect(await db.getAdapter(AdultUser).tableExists!()).toBe(false);

    const readded = await sync.run([User, AdultUser], { force: true });
    expect(readded.entries.find((e) => e.name === "adult_users")?.status).toBe("create");
    expect(await db.getAdapter(AdultUser).tableExists!()).toBe(true);
  });

  it("every adapter of a space serves one table per name; separate spaces do not share", async () => {
    const db = createTestSpace();
    await db.getTable(User).insertOne(user({ id: "u1" }));
    // The administrative adapter (a readable-less factory product) drops by name
    await db.dropTableByName("users");
    expect(await db.getTable(User).count()).toBe(0);
    await db.getTable(User).insertOne(user({ id: "u2" }));
    expect(await createTestSpace().getTable(User).count()).toBe(0);
    expect(await db.getTable(User).count()).toBe(1);
  });

  it("a missing name is not an error; the wrong object kind is", async () => {
    const db = createTestSpace();
    await db.dropTableByName("never_created");
    await db.dropViewByName("never_created");
    await db.getAdapter(User).ensureTable();
    await db.getAdapter(AdultUser).ensureTable();
    await expect(db.dropViewByName("users")).rejects.toThrow(
      'Cannot drop view "users": it is a table',
    );
    await expect(db.dropTableByName("adult_users")).rejects.toThrow(
      'Cannot drop table "adult_users": it is a view',
    );
  });

  it("reads and updates never create a missing table; an insert does", async () => {
    const db = createTestSpace();
    const users = db.getTable(User);
    const adapter = db.getAdapter(User);
    expect(await users.count()).toBe(0);
    expect(await users.updateMany({ id: "x" }, { name: "N" })).toMatchObject({ matchedCount: 0 });
    expect(await users.deleteMany({})).toMatchObject({ deletedCount: 0 });
    expect(await adapter.tableExists!()).toBe(false);
    await users.insertOne(user({ id: "u1" }));
    expect(await adapter.tableExists!()).toBe(true);
  });

  // The core rule behind the fix: an adapter WITHOUT the drop primitive gets an
  // error entry and keeps its rows — sync never reports a drop that did not happen.
  it("an adapter without dropTableByName support: the removed table is an error entry, rows and tracking kept", async () => {
    // Back to the base default: an adapter that does not support dropping by name
    class NoDropAdapter extends MemoryAdapter {
      override dropTableByName(name: string): Promise<void> {
        return BaseDbAdapter.prototype.dropTableByName.call(this, name);
      }
    }
    const db = new DbSpace(() => new NoDropAdapter());
    const sync = new SchemaSync(db);
    await sync.run([User, Composite], { force: true });
    await db.getTable(User).insertOne(user({ id: "u1" }));

    const removed = await sync.run([Composite], { force: true, onError: "silent" });
    const entry = removed.entries.find((e) => e.name === "users")!;
    expect(entry.status).toBe("error");
    expect(entry.errors[0]).toBe(
      'Drop of "users" failed: Cannot drop table "users": dropTableByName is not supported by this adapter',
    );
    expect(await db.getTable(User).count()).toBe(1);
    // Still tracked: the next run plans the drop again
    const plan = await sync.plan([Composite], { force: true });
    expect(plan.entries.find((e) => e.name === "users")?.status).toBe("drop");
  });

  it("an adapter used without a space keeps its own store", async () => {
    const space = new DbSpace(() => new MemoryAdapter());
    const table = space.getTable(User);
    await table.insertOne(user({ id: "u1" }));
    const standalone = new MemoryAdapter();
    await standalone.dropTableByName("users");
    expect(await table.count()).toBe(1);
  });
});
