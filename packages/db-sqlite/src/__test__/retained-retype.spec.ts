import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Safe mode keeps a removed table. When its foreign key references a column
// whose type changes, the change waits for the run that drops the table —
// the order a run without safe applies (drop the removed table, then change
// the type) — instead of running under the kept constraint. Since 0.1.173.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/retained-retype.as");
});

beforeEach(async () => {
  driver = new BetterSqlite3Driver(":memory:");
  const space = new DbSpace(() => new SqliteAdapter(driver));
  const v1 = await new SchemaSync(space).run([fx.RrParent, fx.RrChild], { force: true });
  expect(v1.status).toBe("synced");
  await space.getTable(fx.RrParent).insertOne({ id: 1, code: "7" } as never);
  await space.getTable(fx.RrChild).insertOne({ id: 1, parentCode: "7" } as never);
});

afterEach(() => {
  driver.close();
});

const columnType = (table: string, column: string) =>
  driver
    .all<{ name: string; type: string }>(`PRAGMA table_info("${table}")`)
    .find((c) => c.name === column)?.type;

describe("[sqlite] safe mode: a retype under a kept removed table's foreign key", () => {
  it("waits — pending, nothing rebuilt; the next run without safe drops the table, then retypes", async () => {
    const space = new DbSpace(() => new SqliteAdapter(driver));
    const sync = new SchemaSync(space);
    const waiting = {
      column: "code",
      fromType: "TEXT",
      toType: "number",
      waitsFor: ["rr_children"],
    };

    const plan = await sync.plan([fx.RrParentV2], { safe: true });
    const planned = plan.entries.find((e) => e.name === "rr_parents")!;
    expect([planned.typeChanges, planned.skipped]).toEqual([[waiting], ["retype"]]);

    const safe = await sync.run([fx.RrParentV2], { safe: true });
    const entry = safe.entries.find((e) => e.name === "rr_parents")!;
    expect([entry.status, entry.typeChanges, entry.skipped, entry.pending]).toEqual([
      "alter",
      [waiting],
      ["retype"],
      true,
    ]);
    // not rebuilt: the column keeps its type, the kept table its rows and constraint
    expect(columnType("rr_parents", "code")).toBe("TEXT");
    expect(driver.all(`SELECT * FROM "rr_children"`)).toEqual([{ id: 1, parentCode: "7" }]);
    expect(driver.all(`PRAGMA foreign_key_list("rr_children")`)).toHaveLength(1);

    // pending → the hash was withheld: the next run without safe applies it
    const next = await sync.run([fx.RrParentV2]);
    expect(next.status).toBe("synced");
    expect(next.entries.map((e) => [e.name, e.status])).toEqual([
      ["rr_children", "drop"],
      ["rr_parents", "alter"],
    ]);
    expect(columnType("rr_parents", "code")).toBe("REAL");
    expect(driver.all(`SELECT * FROM "rr_parents"`)).toEqual([{ id: 1, code: 7 }]);
  });
});
