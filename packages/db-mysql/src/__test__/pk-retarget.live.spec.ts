import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips
// otherwise (see primitive-defaults.live.spec.ts). A populated parent's key
// moves and the child retargets its FK, but a child row has no match under
// the new key: the parent is rebuilt (`pkChange.populated` on the run entry),
// the child's step fails naming the pre-dropped FK once, and a re-run after
// the row is fixed adds the FK.

const DB = "pk_retarget";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let driver: Mysql2Driver;
let space: DbSpace;

async function childFkTarget(): Promise<string | undefined> {
  const row = await driver.get<{ REFERENCED_COLUMN_NAME: string }>(
    `SELECT REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pkr_children'
        AND REFERENCED_TABLE_NAME IS NOT NULL`,
  );
  return row?.REFERENCED_COLUMN_NAME;
}

describe.skipIf(!reachable)("[mysql live] primary-key change with a retargeting child", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/pk-retarget.as");
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
  });

  afterAll(async () => {
    await space?.close();
    await dropMysqlDatabase(DB);
  });

  it("rebuilds the parent, names the dropped FK once, and adds it once the child row is fixed", async () => {
    const before = [fx.PkrParentBefore, fx.PkrChildBefore];
    const after = [fx.PkrParentAfter, fx.PkrChildAfter];
    expect((await new SchemaSync(space).run(before, { force: true })).status).toBe("synced");
    await driver.exec("INSERT INTO `pkr_parents` (`code`, `alt`, `name`) VALUES ('c1', 'a1', 'P')");
    await driver.exec("INSERT INTO `pkr_children` (`parentRef`) VALUES ('c1')");
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

    await driver.exec("UPDATE `pkr_children` SET `parentRef` = 'a1'");
    const fixed = await new SchemaSync(space).run(after, { force: true });
    expect(fixed.status).toBe("synced");
    expect(fixed.entries.find((e) => e.name === "pkr_children")!.errors).toEqual([]);
    expect(await childFkTarget()).toBe("alt");
    expect((await new SchemaSync(space).run(after)).status).toBe("up-to-date");
  });
});
