import { describe, it, beforeAll, beforeEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";
import {
  checkBoundedCascade,
  checkBoundedComposite,
  checkBoundedRace,
  checkBoundedWrites,
  checkBulkValidation,
  checkCounterUpgrade,
  checkOnUpdateInc,
  type TBulkWriteTables,
} from "./bulk-writes-check";

// Bounded writes run as `rowid IN (SELECT rowid … ORDER BY … LIMIT n)`;
// `@db.onUpdate.inc` as `col = col + 1` (since 0.1.162).

let fx: Record<string, any>;
let t: TBulkWriteTables;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/bulk-writes.as");
});

beforeEach(async () => {
  const driver = new BetterSqlite3Driver(":memory:");
  const space = new DbSpace(() => new SqliteAdapter(driver));
  t = {
    tasks: space.getTable(fx.BwTask),
    owners: space.getTable(fx.BwOwner),
    items: space.getTable(fx.BwItem),
  };
  for (const table of [t.tasks, t.owners, t.items]) await table.ensureTable();
});

describe("SqliteAdapter — bounded writes, @db.onUpdate.inc, validated bulk payloads", () => {
  it("@db.onUpdate.inc moves on every write path; touchMany stamps @db.onUpdate.now", () =>
    checkOnUpdateInc(t));
  it("updateMany / replaceMany validate their payload", () => checkBulkValidation(t));
  it("bounded updateMany / deleteMany", () => checkBoundedWrites(t));
  it("a bounded write that loses its picked rows to a concurrent writer retries while matches remain", () =>
    checkBoundedRace(t.tasks));
  it("a bounded delete with a native FK cascade", () => checkBoundedCascade(t));
  it("bounded writes on a composite renamed key, NULL sort keys, a self-relation", async () => {
    const driver = new BetterSqlite3Driver(":memory:");
    const space = new DbSpace(() => new SqliteAdapter(driver));
    const boards = space.getTable(fx.BwBoard);
    await boards.ensureTable();
    await checkBoundedComposite(boards);
  });
});

describe("SqliteAdapter — @db.onUpdate.inc on an existing table", () => {
  it("schema sync backfills 0; updates count from there", async () => {
    const driver = new BetterSqlite3Driver(":memory:");
    await checkCounterUpgrade(new DbSpace(() => new SqliteAdapter(driver)), SchemaSync, fx);
    driver.close();
  });
});
