import { SchemaSync } from "@atscript/db/sync";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { createTestSpace, prepareFixtures } from "./test-utils";

let User: any;
let AdultUser: any;
let AdultUsersTable: any;
let UserNote: any;

// Since 0.1.138: `getObjectKind` lets schema sync see what sits under a name
// in the space's in-memory database, like the SQL and MongoDB adapters.
describe("MemoryAdapter — getObjectKind and the pre-flight checks it enables", () => {
  beforeAll(async () => {
    await prepareFixtures();
    User = (await import("./fixtures/stored.as")).User;
    ({ AdultUser, AdultUsersTable, UserNote } = await import("./fixtures/views.as"));
  });

  it("reports table, view, or undefined", async () => {
    const db = createTestSpace();
    const sync = new SchemaSync(db);
    await sync.run([User, AdultUser], { force: true });
    const adapter = db.getAdapter(User);
    expect(await adapter.getObjectKind!("users")).toBe("table");
    expect(await adapter.getObjectKind!("adult_users")).toBe("view");
    expect(await adapter.getObjectKind!("missing")).toBeUndefined();
  });

  it("refuses a managed view declared where a table sits", async () => {
    const db = createTestSpace();
    await db.getTable(AdultUsersTable).insertOne({ id: "t1" });
    const result = await new SchemaSync(db).run([User, AdultUser], {
      force: true,
      onError: "silent",
    });
    expect(result.status).toBe("refused");
    expect(result.entries.find((e) => e.name === "adult_users")!.errors[0]).toContain(
      'A physical table "adult_users" exists where managed view "adult_users" is declared',
    );
    expect(await db.getTable(AdultUsersTable).count()).toBe(1);
  });

  it("refuses a table declared where a view sits", async () => {
    const db = createTestSpace();
    await db.getAdapter(AdultUser).ensureTable();
    const result = await new SchemaSync(db).run([AdultUsersTable], {
      force: true,
      onError: "silent",
    });
    expect(result.status).toBe("refused");
    expect(await db.getAdapter(AdultUser).getObjectKind!("adult_users")).toBe("view");
  });

  it("refuses an FK to a table that is neither synced nor present", async () => {
    const db = createTestSpace();
    const missing = await new SchemaSync(db).run([UserNote], { force: true, onError: "silent" });
    expect(missing.status).toBe("refused");
    expect(missing.entries.find((e) => e.name === "user_notes")!.errors[0]).toContain(
      'references "users" which is neither in the sync inventory nor present in the database',
    );

    await db.getAdapter(User).ensureTable();
    const present = await new SchemaSync(db).run([UserNote], { force: true });
    expect(present.status).toBe("synced");
  });
});
