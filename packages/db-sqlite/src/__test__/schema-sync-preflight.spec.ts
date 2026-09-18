import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace, AtscriptDbView } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

let fx: Record<string, any>;
let CycleA: any;
let CycleB: any;

// Real in-memory coverage for the three-phase schema sync (since 0.1.128):
// primary-key rebuilds/refusals, dependency-ordered creates and drops,
// structural view detection and the new adapter primitives.
describe("SQLite: schema-sync pre-flight, ordering and primitives", () => {
  let driver: BetterSqlite3Driver;

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/sync-preflight.as");
    CycleA = (await import("./fixtures/pf-cycle-a.as")).PfCycleA;
    CycleB = (await import("./fixtures/pf-cycle-b.as")).PfCycleB;
  });

  beforeEach(() => {
    driver = new BetterSqlite3Driver(":memory:");
  });

  afterEach(() => {
    driver.close();
  });

  function spaceFor(): DbSpace {
    return new DbSpace(() => new SqliteAdapter(driver));
  }

  function syncFor(space = spaceFor()) {
    return new SchemaSync(space);
  }

  function pkColumns(table: string): string[] {
    return driver
      .all<{ name: string; pk: number }>(`PRAGMA table_info("${table}")`)
      .filter((c) => c.pk > 0)
      .map((c) => c.name);
  }

  function columns(table: string): string[] {
    return driver.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((c) => c.name);
  }

  function objectType(name: string): string | undefined {
    return driver.get<{ type: string }>(`SELECT type FROM sqlite_master WHERE name = ?`, [name])
      ?.type;
  }

  // ── Primary-key change ─────────────────────────────────────────────────

  it("rebuilds the primary key of an EMPTY table via recreate and is idempotent", async () => {
    const sync = syncFor();
    expect((await sync.run([fx.PfTokenV1], { force: true })).status).toBe("synced");
    expect(pkColumns("pf_tokens")).toEqual(["id"]);

    const plan = await sync.plan([fx.PfTokenV2], { force: true });
    const planned = plan.entries.find((e) => e.name === "pf_tokens")!;
    expect(planned.pkChange).toEqual({ from: ["id"], to: ["code"], rebuild: true });

    const result = await sync.run([fx.PfTokenV2], { force: true, onError: "silent" });
    expect(result.status).toBe("synced");
    const entry = result.entries.find((e) => e.name === "pf_tokens")!;
    expect(entry.status).toBe("alter");
    expect(entry.recreated).toBe(true);
    expect(entry.pkChange).toEqual({ from: ["id"], to: ["code"], rebuild: true });
    expect(pkColumns("pf_tokens")).toEqual(["code"]);
    // Unique indexes reconciled: id is unique now, the old code index is gone
    const idx = driver
      .all<{ name: string }>(`PRAGMA index_list("pf_tokens")`)
      .map((i) => i.name)
      .filter((n) => n.startsWith("atscript__"));
    expect(idx).toContain("atscript__unique__pf_id_idx");
    expect(idx).not.toContain("atscript__unique__pf_code_idx");

    expect((await sync.run([fx.PfTokenV2])).status).toBe("up-to-date");
  });

  it("drops the old key column in the same sync (recreate handles both)", async () => {
    const sync = syncFor();
    await sync.run([fx.PfTokenV1], { force: true });
    const result = await sync.run([fx.PfTokenDropOld], { force: true, onError: "silent" });
    expect(result.status).toBe("synced");
    expect(pkColumns("pf_tokens")).toEqual(["code"]);
    expect(columns("pf_tokens")).toEqual(["code", "label"]);
  });

  it("refuses the change on a POPULATED table and leaves the schema untouched", async () => {
    const sync = syncFor();
    await sync.run([fx.PfTokenV1], { force: true });
    driver.exec(`INSERT INTO "pf_tokens" ("code", "label") VALUES ('a', 'A')`);

    const before = driver.all(`PRAGMA table_info("pf_tokens")`);
    const result = await sync.run([fx.PfTokenV2], { force: true, onError: "silent" });
    expect(result.status).toBe("refused");
    const entry = result.entries.find((e) => e.name === "pf_tokens")!;
    expect(entry.refused).toBe(true);
    expect(entry.errors[0]).toBe(
      'Primary key of "pf_tokens" changed (id → code) but the table has rows; schema sync cannot rebuild a populated primary key. Migrate manually (or empty the table) and re-run.',
    );
    expect(driver.all(`PRAGMA table_info("pf_tokens")`)).toEqual(before);
    expect(driver.all(`SELECT * FROM "pf_tokens"`)).toHaveLength(1);
    // Lock released, nothing tracked/hashed → next plan shows the change again
    const plan = await sync.plan([fx.PfTokenV2]);
    expect(plan.status).toBe("changes-needed");
    expect(plan.entries.find((e) => e.name === "pf_tokens")!.refused).toBe(true);

    // Emptied → allowed
    driver.exec(`DELETE FROM "pf_tokens"`);
    expect((await sync.run([fx.PfTokenV2], { force: true, onError: "silent" })).status).toBe(
      "synced",
    );
    expect(pkColumns("pf_tokens")).toEqual(["code"]);
  });

  it("refuses when an auto-increment column leaves the key", async () => {
    const sync = syncFor();
    await sync.run([fx.PfTokenV1], { force: true });
    const result = await sync.run([fx.PfTokenV2Inc], { force: true, onError: "silent" });
    expect(result.status).toBe("refused");
    expect(result.entries.find((e) => e.name === "pf_tokens")!.errors).toContain(
      '"pf_tokens.id" is auto-increment but no longer part of the primary key; auto-increment columns must be primary-key columns.',
    );
    expect(pkColumns("pf_tokens")).toEqual(["id"]);
  });

  // ── Dependency order ───────────────────────────────────────────────────

  it("creates a shuffled inventory parents-first and records dependsOn", async () => {
    const sync = syncFor();
    const result = await sync.run([fx.PfPath, fx.PfIssue, fx.PfTeam], { force: true });
    expect(result.status).toBe("synced");
    expect(result.entries.map((e) => e.name)).toEqual(["pf_teams", "pf_issues", "pf_paths"]);
    expect(result.entries[2].dependsOn).toEqual(["pf_issues"]);
    const fks = driver.all<{ table: string }>(`PRAGMA foreign_key_list("pf_paths")`);
    expect(fks.map((f) => f.table)).toEqual(["pf_issues"]);
  });

  it("creates a foreign-key cycle and both constraints exist", async () => {
    const result = await syncFor().run([CycleB, CycleA], { force: true });
    expect(result.status).toBe("synced");
    expect(driver.all<{ table: string }>(`PRAGMA foreign_key_list("pf_cycle_a")`)[0].table).toBe(
      "pf_cycle_b",
    );
    expect(driver.all<{ table: string }>(`PRAGMA foreign_key_list("pf_cycle_b")`)[0].table).toBe(
      "pf_cycle_a",
    );
  });

  it("drops populated children before parents and keeps the bystander", async () => {
    const sync = syncFor();
    await sync.run([fx.PfParent, fx.PfChild, fx.PfSurvivor], { force: true });
    driver.exec(`INSERT INTO "pf_parents" ("name") VALUES ('p')`);
    driver.exec(`INSERT INTO "pf_children" ("parentId") VALUES (1)`);
    driver.exec(`INSERT INTO "pf_survivors" ("name") VALUES ('s')`);

    const plan = await sync.plan([fx.PfSurvivor], { force: true });
    const drops = plan.entries.filter((e) => e.status === "drop").map((e) => e.name);
    expect(drops).toEqual(["pf_children", "pf_parents"]);

    const result = await sync.run([fx.PfSurvivor], { force: true, onError: "silent" });
    expect(result.status).toBe("synced");
    expect(objectType("pf_parents")).toBeUndefined();
    expect(objectType("pf_children")).toBeUndefined();
    expect(driver.all(`SELECT * FROM "pf_survivors"`)).toHaveLength(1);
    expect((await sync.run([fx.PfSurvivor])).status).toBe("up-to-date");
  });

  it("drops a populated foreign-key cycle as one group and restores FK enforcement", async () => {
    const sync = syncFor();
    await sync.run([CycleA, CycleB], { force: true });
    driver.exec(`INSERT INTO "pf_cycle_a" ("id", "name") VALUES (1, 'a')`);
    driver.exec(`INSERT INTO "pf_cycle_b" ("id", "name", "aId") VALUES (1, 'b', 1)`);
    driver.exec(`UPDATE "pf_cycle_a" SET "bId" = 1`);

    const result = await sync.run([], { force: true, onError: "silent" });
    expect(result.status).toBe("synced");
    const a = result.entries.find((e) => e.name === "pf_cycle_a")!;
    expect(a.status).toBe("drop");
    expect(a.dropGroup).toEqual(["pf_cycle_a", "pf_cycle_b"]);
    expect(objectType("pf_cycle_a")).toBeUndefined();
    expect(objectType("pf_cycle_b")).toBeUndefined();
    expect(driver.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys).toBe(1);
  });

  it("refuses to drop a parent that a surviving child still references", async () => {
    const sync = syncFor();
    await sync.run([fx.PfParent, fx.PfChild], { force: true });
    const result = await sync.run([fx.PfChild], { force: true, onError: "silent" });
    expect(result.status).toBe("refused");
    expect(result.entries.find((e) => e.name === "pf_parents")!.errors[0]).toBe(
      'Cannot drop "pf_parents": it is still referenced by pf_children.parentId (@db.rel.FK). Add "pf_parents" to the sync inventory or remove the reference.',
    );
    expect(objectType("pf_parents")).toBe("table");
  });

  it("refuses a primary-key change while a child still references the old key", async () => {
    // pf_children.parentId → pf_parents.id; pretend pf_parents' key moves by
    // reusing the token fixtures: build an inbound FK to pf_tokens manually.
    const sync = syncFor();
    await sync.run([fx.PfTokenV1], { force: true });
    driver.exec(
      `CREATE TABLE "legacy_ref" ("id" INTEGER PRIMARY KEY, "tokenId" INTEGER REFERENCES "pf_tokens"("id"))`,
    );
    const result = await sync.run([fx.PfTokenV2], { force: true, onError: "silent" });
    expect(result.status).toBe("refused");
    expect(result.entries.find((e) => e.name === "pf_tokens")!.errors[0]).toBe(
      'Primary key of "pf_tokens" changed (id → code) but "legacy_ref.tokenId" still references the old key — retarget the foreign key (or migrate manually) and re-run.',
    );
    expect(pkColumns("pf_tokens")).toEqual(["id"]);
  });

  // ── Views ──────────────────────────────────────────────────────────────

  it("excludes @db.ignore fields from CREATE VIEW", async () => {
    const result = await syncFor().run([fx.PfTokenV1, fx.PfTokenList], { force: true });
    expect(result.status).toBe("synced");
    expect(columns("pf_token_list")).toEqual(["id", "label"]);
    driver.exec(`INSERT INTO "pf_tokens" ("code", "label") VALUES ('a', 'A')`);
    expect(driver.all(`SELECT * FROM "pf_token_list"`)).toEqual([{ id: 1, label: "A" }]);
  });

  it("creates a view for a duck-typed readable (structural isView, not instanceof)", async () => {
    const real = spaceFor().getView(fx.PfTokenList) as AtscriptDbView;
    await spaceFor().getTable(fx.PfTokenV1).ensureTable();
    const duck = {
      isView: true,
      isExternal: false,
      tableName: real.tableName,
      schema: undefined,
      viewPlan: real.viewPlan,
      fieldDescriptors: real.fieldDescriptors,
      getViewColumnMappings: () => real.getViewColumnMappings(),
      resolveFieldRef: (ref: any, qi?: any) => real.resolveFieldRef(ref, qi),
    };
    expect(duck instanceof AtscriptDbView).toBe(false);
    const adapter = new SqliteAdapter(driver);
    adapter.registerReadable(duck as any);
    await adapter.ensureTable();
    expect(objectType("pf_token_list")).toBe("view");
  });

  it("refuses when a physical table sits where a managed view is declared", async () => {
    driver.exec(`CREATE TABLE "pf_token_list" ("id" INTEGER)`);
    const result = await syncFor().run([fx.PfTokenV1, fx.PfTokenList], {
      force: true,
      onError: "silent",
    });
    expect(result.status).toBe("refused");
    expect(result.entries.find((e) => e.name === "pf_token_list")!.errors[0]).toBe(
      'A physical table "pf_token_list" exists where managed view "pf_token_list" is declared — drop or rename it',
    );
    expect(objectType("pf_token_list")).toBe("table");
    expect(objectType("pf_tokens")).toBeUndefined();
  });

  // ── Primitives ─────────────────────────────────────────────────────────

  it("hasRows / getObjectKind / getReferencingForeignKeys", async () => {
    const space = spaceFor();
    await syncFor(space).run([fx.PfParent, fx.PfChild, fx.PfTokenList, fx.PfTokenV1], {
      force: true,
    });
    const adapter = space.getAdapter(fx.PfParent) as SqliteAdapter;

    expect(await adapter.hasRows()).toBe(false);
    driver.exec(`INSERT INTO "pf_parents" ("name") VALUES ('p')`);
    expect(await adapter.hasRows()).toBe(true);
    expect(await adapter.hasRows("pf_children")).toBe(false);

    expect(await adapter.getObjectKind("pf_parents")).toBe("table");
    expect(await adapter.getObjectKind("pf_token_list")).toBe("view");
    expect(await adapter.getObjectKind("nope")).toBeUndefined();

    expect(await adapter.getReferencingForeignKeys("pf_parents")).toEqual([
      { table: "pf_children", fields: ["parentId"], targetFields: ["id"] },
    ]);
    expect(await adapter.getReferencingForeignKeys("pf_children")).toEqual([]);
  });

  // `DbSpace` runs the name-taking primitives on a factory-fresh adapter that
  // never had a readable registered — they must not touch `this._table`.
  it("administrative adapter (no registered readable): every name-taking primitive works", async () => {
    const space = spaceFor();
    await syncFor(space).run([fx.PfParent, fx.PfChild, fx.PfTokenList, fx.PfTokenV1], {
      force: true,
    });
    driver.exec(`INSERT INTO "pf_parents" ("name") VALUES ('p')`);

    const admin = new SqliteAdapter(driver);
    expect(await admin.hasRows("pf_parents")).toBe(true);
    expect(await admin.hasRows("pf_children")).toBe(false);
    expect(await admin.getObjectKind("pf_parents")).toBe("table");
    expect(await admin.getObjectKind("pf_token_list")).toBe("view");
    expect(await admin.getReferencingForeignKeys("pf_parents")).toEqual([
      { table: "pf_children", fields: ["parentId"], targetFields: ["id"] },
    ]);
    expect((await admin.getExistingColumnsForTable("pf_parents")).map((c) => c.name)).toContain(
      "name",
    );
    await expect(admin.hasRows()).rejects.toThrow(/no registered readable/);

    // The space's own admin adapter is such an unbound adapter
    expect(await space.getReferencingForeignKeys("pf_parents")).toHaveLength(1);
    await space.dropViewByName("pf_token_list");
    await space.dropTablesByName(["pf_children", "pf_parents"]);
    expect(await admin.getObjectKind("pf_token_list")).toBeUndefined();
    expect(await admin.getObjectKind("pf_children")).toBeUndefined();
    expect(await admin.getObjectKind("pf_parents")).toBeUndefined();
    expect(driver.get<{ fk: number }>("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
  });
});
