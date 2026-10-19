import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

let fx: Record<string, any>;

/** Statement shapes on PostgreSQL (recording driver, since 0.1.162). */
describe("PostgresAdapter — bounded writes and @db.onUpdate.inc", () => {
  let driver: ReturnType<typeof createMockDriver>;
  let tasks: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/bulk-writes.as");
  });

  beforeEach(() => {
    driver = createMockDriver({ getResult: { cnt: 1 }, runResult: { affectedRows: 2 } });
    tasks = new AtscriptDbTable(fx.BwTask, new PostgresAdapter(driver));
  });

  const runs = (prefix: string) =>
    driver.calls.filter((c) => c.method === "run" && c.sql.startsWith(prefix));

  it("bounded deleteMany re-keys on the PK through an ordered, limited subquery", async () => {
    await tasks.deleteMany({ status: "old" }, { limit: 2, sort: { priority: -1 } });
    const [stmt] = runs("DELETE");
    expect(stmt!.sql).toBe(
      'DELETE FROM "bw_tasks" WHERE "status" = $1 AND "id" IN (SELECT "id" FROM "bw_tasks" WHERE "status" = $2 ORDER BY "priority" DESC, "id" DESC LIMIT 2)',
    );
    expect(stmt!.params).toEqual(["old", "old"]);
  });

  it("bounded updateMany uses the same predicate", async () => {
    await tasks.updateMany({ status: "old" }, { note: "n" }, { limit: 3 });
    const [stmt] = runs("UPDATE");
    expect(stmt!.sql).toContain(
      'WHERE "status" = $4 AND "id" IN (SELECT "id" FROM "bw_tasks" WHERE "status" = $5 ORDER BY "id" ASC LIMIT 3)',
    );
    expect(stmt!.sql).toContain('"rev" = "rev" + $3');
  });

  it("a replace increments the counter instead of assigning it", async () => {
    await tasks.replaceOne({ id: 1, status: "s", priority: 0, title: "r", rev: 9 } as any);
    await tasks.replaceMany({ id: 1 }, { status: "s", priority: 0, title: "r" } as any);
    for (const stmt of runs("UPDATE")) {
      expect(stmt.sql).toMatch(/"rev" = "rev" \+ \$\d+/);
      expect(stmt.sql).not.toMatch(/"rev" = \$\d+/);
    }
  });

  it("touchMany stamps @db.onUpdate.now and increments the counter", async () => {
    driver = createMockDriver({ getResult: { cnt: 1 }, runResult: { affectedRows: 1 } });
    tasks = new AtscriptDbTable(fx.BwTask, new PostgresAdapter(driver));
    await tasks.touchMany([{ id: 1, version: 0 }] as any);
    const [stmt] = runs("UPDATE");
    expect(stmt!.sql).toBe(
      'UPDATE "bw_tasks" SET "updatedAt" = $1, "rev" = "rev" + $2, "version" = "version" + 1 WHERE ("id" = $3 AND "version" = $4)',
    );
  });
});
