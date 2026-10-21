import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// Since 0.1.165 `number.timestamp.created` is insert-only: a replace leaves
// the column out of its assignment (before: it was reset to its DEFAULT when
// the payload omitted it, or set to the payload's value), and a patch never
// writes it.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/created-insert-only.as");
});

function setup() {
  const driver = createMockDriver({ runResult: { affectedRows: 1 } } as any);
  const space = new DbSpace(() => new PostgresAdapter(driver as any));
  return { driver, notes: space.getTable(fx.CioNote) as any };
}

const writes = (driver: { calls: Array<{ sql: string }> }) =>
  driver.calls.map((c) => c.sql).filter((sql) => sql.startsWith("UPDATE"));

describe("[postgres] created is insert-only", () => {
  it("replaceOne never assigns createdAt", async () => {
    const { driver, notes } = setup();
    await notes.replaceOne({ id: 1, title: "b" });
    await notes.replaceOne({ id: 1, title: "b", createdAt: 5 });
    const sqls = writes(driver);
    expect(sqls).toHaveLength(2);
    for (const sql of sqls) expect(sql).not.toContain('"createdAt"');
  });

  it("updateOne / updateMany / replaceMany never assign createdAt", async () => {
    const { driver, notes } = setup();
    await notes.updateOne({ id: 1, title: "x", createdAt: 5 });
    await notes.updateMany({ id: 1 }, { title: "y", createdAt: 6 });
    await notes.replaceMany({ id: 1 }, { title: "z", createdAt: 7 });
    const sqls = writes(driver);
    expect(sqls).toHaveLength(3);
    for (const sql of sqls) expect(sql).not.toContain('"createdAt"');
  });
});
