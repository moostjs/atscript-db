import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

let V1: any;
let V2: any;

// Repro for: dropping a column whose @db.index.* annotation vanished with it
// failed on SQLite — ALTER TABLE … DROP COLUMN ran while the managed index
// still referenced the column ("error in index … after drop column").
// Sync must drop managed indexes referencing removed columns first
// (dropIndexesForColumns), then drop the columns, then recreate surviving
// indexes from the model.
describe("SQLite: dropping indexed columns", () => {
  let driver: BetterSqlite3Driver;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/drop-indexed-column.as");
    V1 = fixtures.DropIdxGadgetV1;
    V2 = fixtures.DropIdxGadgetV2;
  });

  beforeEach(() => {
    driver = new BetterSqlite3Driver(":memory:");
  });

  afterEach(() => {
    driver.close();
  });

  function syncFor(type: any) {
    const space = new DbSpace(() => new SqliteAdapter(driver));
    const sync = new SchemaSync(space);
    return { space, sync, type };
  }

  function indexNames(): string[] {
    return driver
      .all<{ name: string }>(`PRAGMA index_list("drop_idx_gadgets")`)
      .map((i) => i.name)
      .filter((n) => n.startsWith("atscript__"));
  }

  it("drops managed indexes before dropping their columns", async () => {
    const v1 = syncFor(V1);
    const r1 = await v1.sync.run([V1], { force: true });
    expect(r1.status).toBe("synced");
    expect(indexNames()).toEqual(
      expect.arrayContaining([
        "atscript__unique__didx_email",
        "atscript__plain__didx_code",
        "atscript__plain__didx_region_status",
      ]),
    );

    driver.exec(
      `INSERT INTO "drop_idx_gadgets" ("name", "email", "code", "region", "status")
       VALUES ('widget-a', 'a@example.com', 'C-1', 'eu', 'active')`,
    );

    // V2 removes email + code entirely and drops status from the composite
    const v2 = syncFor(V2);
    const r2 = await v2.sync.run([V2], { force: true });
    expect(r2.status).toBe("synced");

    const cols = driver
      .all<{ name: string }>(`PRAGMA table_info("drop_idx_gadgets")`)
      .map((c) => c.name);
    expect(cols).toContain("name");
    expect(cols).toContain("region");
    expect(cols).not.toContain("email");
    expect(cols).not.toContain("code");
    expect(cols).not.toContain("status");

    const indexes = indexNames();
    expect(indexes).not.toContain("atscript__unique__didx_email");
    expect(indexes).not.toContain("atscript__plain__didx_code");
    expect(indexes).toContain("atscript__plain__didx_region_status");

    // Composite index recreated narrowed to the surviving column
    const compositeCols = driver
      .all<{ name: string | null }>(`PRAGMA index_info("atscript__plain__didx_region_status")`)
      .map((c) => c.name);
    expect(compositeCols).toEqual(["region"]);

    // Data in surviving columns preserved
    const rows = driver.all<{ name: string; region: string }>(`SELECT * FROM "drop_idx_gadgets"`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("widget-a");
    expect(rows[0]!.region).toBe("eu");

    // Idempotent: a second run sees nothing to do
    const r3 = await syncFor(V2).sync.run([V2]);
    expect(r3.status).toBe("up-to-date");
  });

  it("dropIndexesForColumns only drops managed indexes referencing the given columns", async () => {
    const v1 = syncFor(V1);
    await v1.sync.run([V1], { force: true });
    // Unmanaged index must never be touched
    driver.exec(`CREATE INDEX "user_made_idx" ON "drop_idx_gadgets" ("email")`);

    const adapter = v1.space.getAdapter(V1) as SqliteAdapter;
    await adapter.dropIndexesForColumns(["email"]);

    const all = driver
      .all<{ name: string }>(`PRAGMA index_list("drop_idx_gadgets")`)
      .map((i) => i.name);
    expect(all).not.toContain("atscript__unique__didx_email");
    expect(all).toContain("user_made_idx");
    expect(all).toContain("atscript__plain__didx_code");
    expect(all).toContain("atscript__plain__didx_region_status");
  });
});
