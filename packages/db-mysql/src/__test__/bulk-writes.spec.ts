import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

let fx: Record<string, any>;

/** Statement shapes on MySQL (recording driver, since 0.1.162). */
describe("MysqlAdapter — bounded writes and @db.onUpdate.inc", () => {
  let driver: ReturnType<typeof createMockDriver>;
  let tasks: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/bulk-writes.as");
  });

  beforeEach(() => {
    driver = createMockDriver({ runResult: { affectedRows: 2, changedRows: 2 } });
    tasks = new AtscriptDbTable(fx.BwTask, new MysqlAdapter(driver));
  });

  const runs = (prefix: string) =>
    driver.calls.filter((c) => c.method === "run" && c.sql.startsWith(prefix));

  it("bounded deleteMany is a native DELETE … ORDER BY … LIMIT with the PK tie-breaker", async () => {
    expect(await tasks.deleteMany({ status: "old" }, { limit: 2, sort: { priority: -1 } })).toEqual(
      { deletedCount: 2 },
    );
    const [stmt] = runs("DELETE");
    expect(stmt!.sql).toBe(
      "DELETE FROM `bw_tasks` WHERE `status` = ? ORDER BY `priority` DESC, `id` DESC LIMIT 2",
    );
    expect(stmt!.params).toEqual(["old"]);
    // no key read first
    expect(driver.calls.some((c) => c.sql.startsWith("SELECT"))).toBe(false);
  });

  it("bounded updateMany renders ORDER BY … LIMIT after the SET (counter and version included)", async () => {
    await tasks.updateMany({ status: "old" }, { note: "n" }, { limit: 3 });
    const [stmt] = runs("UPDATE");
    expect(stmt!.sql).toMatch(
      /^UPDATE `bw_tasks` SET `note` = \?, `updatedAt` = \?, `rev` = `rev` \+ \?, `version` = `version` \+ 1 WHERE `status` = \? ORDER BY `id` ASC LIMIT 3$/,
    );
  });

  it("a replace increments the counter instead of assigning it", async () => {
    await tasks.replaceOne({ id: 1, status: "s", priority: 0, title: "r", rev: 9 } as any);
    const [stmt] = runs("UPDATE");
    expect(stmt!.sql).toContain("`rev` = `rev` + ?");
    expect(stmt!.sql).not.toMatch(/`rev` = \?/);
    await tasks.replaceMany({ id: 1 }, { status: "s", priority: 0, title: "r" } as any);
    expect(runs("UPDATE")[1]!.sql).toContain("`rev` = `rev` + ?");
  });

  it("touchMany stamps @db.onUpdate.now and increments the counter with the version bump", async () => {
    driver = createMockDriver({
      getResult: { cnt: 1 },
      runResult: { affectedRows: 1, changedRows: 1 },
    });
    tasks = new AtscriptDbTable(fx.BwTask, new MysqlAdapter(driver));
    await tasks.touchMany([{ id: 1, version: 0 }] as any);
    const [stmt] = runs("UPDATE");
    expect(stmt!.sql).toBe(
      "UPDATE `bw_tasks` SET `updatedAt` = ?, `rev` = `rev` + ?, `version` = `version` + 1 WHERE (`id` = ? AND `version` = ?)",
    );
  });
});
