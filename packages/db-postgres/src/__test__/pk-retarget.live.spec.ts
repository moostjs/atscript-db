import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise (see primitive-defaults.live.spec.ts). A populated parent's key
// moves and the child retargets its FK, but a child row has no match under
// the new key: the parent is rebuilt (`pkChange.populated` on the run entry),
// the child's step fails naming the pre-dropped FK once, and a re-run after
// the row is fixed adds the FK.

const DB = "pk_retarget";

const reachable = await pgReachable();

let fx: Record<string, any>;
let driver: PgDriver;
let space: DbSpace;

async function childFkTarget(): Promise<string | undefined> {
  const row = await driver.get<{ col: string }>(
    `SELECT a.attname AS col FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND c.conrelid = 'pkr_children'::regclass`,
  );
  return row?.col;
}

describe.skipIf(!reachable)("[postgres live] primary-key change with a retargeting child", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/pk-retarget.as");
    driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
    space = new DbSpace(() => new PostgresAdapter(driver), { onClose: () => driver.close() });
  });

  afterAll(async () => {
    await space?.close();
    await dropPgDatabase(DB);
  });

  it("rebuilds the parent, names the dropped FK once, and adds it once the child row is fixed", async () => {
    const before = [fx.PkrParentBefore, fx.PkrChildBefore];
    const after = [fx.PkrParentAfter, fx.PkrChildAfter];
    expect((await new SchemaSync(space).run(before, { force: true })).status).toBe("synced");
    await driver.exec(`INSERT INTO "pkr_parents" ("code", "alt", "name") VALUES ('c1', 'a1', 'P')`);
    await driver.exec(`INSERT INTO "pkr_children" ("parentRef") VALUES ('c1')`);
    expect(await childFkTarget()).toBe("code");

    const result = await new SchemaSync(space).run(after, { force: true, onError: "silent" });
    const parent = result.entries.find((e) => e.name === "pkr_parents")!;
    expect(parent.errors).toEqual([]);
    expect(parent.pkChange).toEqual({
      from: ["code"],
      to: ["alt"],
      rebuild: true,
      populated: true,
    });
    const child = result.entries.find((e) => e.name === "pkr_children")!;
    expect(child.status).toBe("error");
    expect(child.errors).toHaveLength(1);
    expect(child.errors[0]).toMatch(/^Index\/FK sync failed on pkr_children: /);
    expect(child.errors[0]).toContain(
      " Dropped foreign keys before the failure: parentRef — the ones still in the model",
    );
    expect(await childFkTarget()).toBeUndefined();

    await driver.exec(`UPDATE "pkr_children" SET "parentRef" = 'a1'`);
    const fixed = await new SchemaSync(space).run(after, { force: true });
    expect(fixed.status).toBe("synced");
    expect(fixed.entries.find((e) => e.name === "pkr_children")!.errors).toEqual([]);
    expect(await childFkTarget()).toBe("alt");
    expect((await new SchemaSync(space).run(after)).status).toBe("up-to-date");
  });
});
