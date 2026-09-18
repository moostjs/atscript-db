import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import type { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { getSqliteTxGate } from "../tx-gate";

import { prepareFixtures, RecordingDriver, deferred, settledWithin } from "./test-utils";

let fx: Record<string, any>;

/**
 * Records, for each `PRAGMA foreign_keys` toggle, the value SQLite reports
 * right after it together with the gate state at that moment.
 */
class FkToggleDriver extends RecordingDriver {
  readonly fkToggles: Array<{ sql: string; foreignKeys: number; gateHeld: boolean }> = [];
  override exec(sql: string): void {
    super.exec(sql);
    if (sql.startsWith("PRAGMA foreign_keys")) {
      this.fkToggles.push({
        sql,
        foreignKeys: this.foreignKeys(),
        gateHeld: getSqliteTxGate(this).held,
      });
    }
  }
  foreignKeys(): number {
    return this.inner.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys;
  }
}

const txStatements = (execs: string[]) => execs.filter((e) => /^(BEGIN|COMMIT|ROLLBACK)/.test(e));

// WHY: schema methods issue DDL and PRAGMA toggles on the shared connection.
// Since 0.1.128 the entry points that await mid-body or toggle PRAGMAs hold
// the per-driver gate WITHOUT `BEGIN` (they never land inside another
// context's transaction, where `PRAGMA foreign_keys` is a no-op); the
// synchronous ones go through the same statement gate as CRUD — either way
// requests never interleave with their DDL.
describe("SQLite schema entry points take the connection gate (since 0.1.128)", () => {
  let inner: BetterSqlite3Driver;
  let driver: FkToggleDriver;
  let space: DbSpace;
  let parents: AtscriptDbTable;
  let children: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/sync-preflight.as");
  });

  beforeEach(() => {
    inner = new BetterSqlite3Driver(":memory:");
    driver = new FkToggleDriver(inner);
    space = new DbSpace(() => new SqliteAdapter(driver));
    // Resolve both tables up front: adapter construction runs `PRAGMA foreign_keys = ON`.
    parents = space.getTable(fx.PfParent);
    children = space.getTable(fx.PfChild);
  });

  afterEach(() => {
    driver.close();
  });

  const gate = () => getSqliteTxGate(driver);
  const parentsAdapter = () => space.getAdapter(fx.PfParent) as SqliteAdapter;
  const childrenAdapter = () => space.getAdapter(fx.PfChild) as SqliteAdapter;

  // (a) another context's open transaction → the schema call queues behind COMMIT
  it("a schema call started while another context holds withTransaction waits for its COMMIT", async () => {
    await parents.ensureTable();
    const hold = deferred();
    const order: string[] = [];
    const tx = parentsAdapter().withTransaction(async () => {
      order.push("tx:start");
      await parentsAdapter().insertOne({ name: "p" });
      await hold.promise;
      order.push("tx:end");
    });
    await new Promise((r) => setTimeout(r, 5));
    driver.execs.length = 0;

    const schema = children.ensureTable().then(() => order.push("schema:done"));
    expect(await settledWithin(schema, 20)).toBe("pending");
    expect(order).toEqual(["tx:start"]);
    expect(driver.execs).toEqual([]); // no DDL slipped into the open transaction

    hold.resolve();
    await Promise.all([tx, schema]);
    expect(order).toEqual(["tx:start", "tx:end", "schema:done"]);
    expect(driver.execs[0]).toBe("COMMIT");
    expect(driver.execs.slice(1).some((e) => e.startsWith("CREATE TABLE"))).toBe(true);
    expect(gate().held).toBe(false);

    // The child table is usable against the committed parent row.
    inner.exec(`INSERT INTO "pf_children" ("parentId") VALUES (1)`);
    expect(inner.all(`SELECT * FROM "pf_children"`)).toHaveLength(1);
  });

  // (b) the PRAGMA toggles are effective because the gate is held without BEGIN
  it("recreateTable toggles PRAGMA foreign_keys effectively while holding the gate (populated parent/child)", async () => {
    await parents.ensureTable();
    await children.ensureTable();
    inner.exec(`INSERT INTO "pf_parents" ("name") VALUES ('p')`);
    inner.exec(`INSERT INTO "pf_children" ("parentId") VALUES (1)`);
    driver.fkToggles.length = 0;
    driver.execs.length = 0;

    await parentsAdapter().recreateTable();

    expect(driver.fkToggles).toEqual([
      { sql: "PRAGMA foreign_keys = OFF", foreignKeys: 0, gateHeld: true },
      { sql: "PRAGMA foreign_keys = ON", foreignKeys: 1, gateHeld: true },
    ]);
    expect(txStatements(driver.execs)).toEqual([]); // no BEGIN — the gate alone serialises
    expect(driver.foreignKeys()).toBe(1);
    expect(gate().held).toBe(false);

    // With foreign_keys OFF + legacy_alter_table ON the rename did not retarget
    // the child's constraint: it still points at "pf_parents" (the rebuilt table)
    // and the populated pair survived.
    expect(
      inner.all<{ table: string }>(`PRAGMA foreign_key_list("pf_children")`).map((f) => f.table),
    ).toEqual(["pf_parents"]);
    expect(inner.all(`SELECT * FROM "pf_parents"`)).toEqual([{ id: 1, name: "p" }]);
    expect(inner.all(`SELECT * FROM "pf_children"`)).toHaveLength(1);
    // FK enforcement is back on afterwards.
    expect(() => inner.exec(`INSERT INTO "pf_children" ("parentId") VALUES (99)`)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("dropTablesByName drops a populated parent before its child with FK checks off, then restores them", async () => {
    await parents.ensureTable();
    await children.ensureTable();
    inner.exec(`INSERT INTO "pf_parents" ("name") VALUES ('p')`);
    inner.exec(`INSERT INTO "pf_children" ("parentId") VALUES (1)`);
    driver.fkToggles.length = 0;

    await parentsAdapter().dropTablesByName(["pf_parents", "pf_children"]);

    expect(driver.fkToggles.map((t) => [t.foreignKeys, t.gateHeld])).toEqual([
      [0, true],
      [1, true],
    ]);
    expect(driver.foreignKeys()).toBe(1);
    expect(gate().held).toBe(false);
    expect(
      inner.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE name LIKE 'pf_%'`),
    ).toEqual([]);
  });

  // (a') a synchronous schema method goes through the statement gate: it
  // waits for the open transaction exactly like a CRUD statement would
  it("a synchronous schema method (renameTable) started during another context's transaction waits for its COMMIT", async () => {
    await parents.ensureTable();
    const hold = deferred();
    const tx = parentsAdapter().withTransaction(async () => {
      await parentsAdapter().insertOne({ name: "p" });
      await hold.promise;
    });
    await new Promise((r) => setTimeout(r, 5));
    driver.execs.length = 0;

    const kindP = childrenAdapter().getObjectKind("pf_parents");
    expect(await settledWithin(kindP, 20)).toBe("pending");
    expect(driver.execs).toEqual([]);

    hold.resolve();
    await tx;
    expect(await kindP).toBe("table");
    expect(driver.execs).toEqual(["COMMIT"]); // the probe ran after COMMIT, outside the tx
    expect(gate().held).toBe(false);
  });

  // (c) inside this driver's own transaction the schema call runs directly
  it("schema methods called inside this driver's own withTransaction run without deadlock (one BEGIN/COMMIT)", async () => {
    await parents.ensureTable();
    driver.execs.length = 0;

    const result = await childrenAdapter().withTransaction(async () => {
      await children.ensureTable();
      await childrenAdapter().syncIndexes();
      const before = (await childrenAdapter().getExistingColumns()).map((c) => c.name);
      await childrenAdapter().dropColumns(["note"]); // nested withTransaction joins
      const after = (await childrenAdapter().getExistingColumns()).map((c) => c.name);
      return {
        before,
        after,
        hasRows: await childrenAdapter().hasRows(),
        kind: await childrenAdapter().getObjectKind("pf_children"),
        refs: await childrenAdapter().getReferencingForeignKeys("pf_parents"),
      };
    });

    expect(result).toEqual({
      before: ["id", "parentId", "note"],
      after: ["id", "parentId"],
      hasRows: false,
      kind: "table",
      refs: [{ table: "pf_children", fields: ["parentId"], targetFields: ["id"] }],
    });
    expect(txStatements(driver.execs)).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    expect(gate().held).toBe(false);
  });

  it("nested schema entry points (ensureTable → ensureView) acquire the gate once", async () => {
    await space.getTable(fx.PfTokenV1).ensureTable();
    const acquire = vi.spyOn(gate(), "acquire");

    await (space.getAdapter(fx.PfTokenList) as SqliteAdapter).ensureTable();

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(gate().held).toBe(false);
    expect(
      inner.get<{ type: string }>(`SELECT type FROM sqlite_master WHERE name = 'pf_token_list'`)
        ?.type,
    ).toBe("view");
  });

  it("a failing schema call releases the gate", async () => {
    await parents.ensureTable();
    await expect(parentsAdapter().renameTable("no_such_table")).rejects.toThrow(/no such table/);
    expect(gate().held).toBe(false);
    await parentsAdapter().withTransaction(async () => parentsAdapter().insertOne({ name: "p" }));
    expect(inner.all(`SELECT * FROM "pf_parents"`)).toHaveLength(1);
  });
});
