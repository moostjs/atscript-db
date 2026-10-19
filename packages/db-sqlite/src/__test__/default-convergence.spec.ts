import { describe, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";
import { defineDefaultConvergenceCases } from "../../../db/test-kit/default-convergence-cases";

// A forced re-sync converges for every default kind (1.0, booleans, decimals,
// `it's`, JSON, arrays, now …): before 0.1.162 SQLite re-diffed several of
// them and recreated the table on every forced run.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

/** Rewrites a table's CREATE statement in place (SQLite has no ALTER for a column default). */
function rewriteTable(name: string, edit: (sql: string) => string): void {
  const { sql } = driver.get<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  )!;
  const next = edit(sql);
  if (next === sql) throw new Error(`rewriteTable(${name}): no change in ${sql}`);
  driver.exec("PRAGMA foreign_keys = OFF");
  driver.exec(`ALTER TABLE "${name}" RENAME TO "${name}__old"`);
  driver.exec(next);
  driver.exec(`INSERT INTO "${name}" SELECT * FROM "${name}__old"`);
  driver.exec(`DROP TABLE "${name}__old"`);
  driver.exec("PRAGMA foreign_keys = ON");
}

describe("SQLite — forced sync converges over every default kind", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/default-kinds.as");
  });

  beforeEach(() => {
    driver = new BetterSqlite3Driver(":memory:");
    space = new DbSpace(() => new SqliteAdapter(driver));
  });

  afterEach(() => {
    driver.close();
  });

  defineDefaultConvergenceCases(() => ({
    fx,
    space,
    indexes: true,
    driftTeamNameDefault: async () =>
      rewriteTable("dk_teams", (sql) => sql.replace(/("name" TEXT NOT NULL)/, "$1 DEFAULT 'zz'")),
  }));
});
