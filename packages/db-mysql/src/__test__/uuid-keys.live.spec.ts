import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips
// otherwise. uuid keys created as VARCHAR(255) by an earlier release become
// CHAR(36) in one sync — the referenced keys and every foreign-key column
// pointing at them (plain, composite, junction, self-reference), with the
// constraints in place before and after. A stored value longer than 36
// characters fails the sync instead of being truncated, and changes nothing.

const DB = "uuid_keys";
const DB_LONG = "uuid_keys_long";

const reachable = await mysqlReachable();

let fx: Record<string, any>;

beforeAll(async () => {
  if (!reachable) return;
  await prepareFixtures();
  fx = await import("./fixtures/uuid-migrate.as");
});

const oldTypes = () => [fx.UmParentOld, fx.UmChildOld, fx.UmTagOld, fx.UmLinkOld, fx.UmNodeOld];
const newTypes = () => [fx.UmParent, fx.UmChild, fx.UmTag, fx.UmLink, fx.UmNode];

const COLUMNS: Array<[string, string]> = [
  ["um_parents", "id"],
  ["um_parents", "pairA"],
  ["um_parents", "pairB"],
  ["um_children", "parentId"],
  ["um_children", "pairA"],
  ["um_children", "pairB"],
  ["um_tags", "id"],
  ["um_links", "parentId"],
  ["um_links", "tagId"],
  ["um_nodes", "id"],
  ["um_nodes", "parentId"],
];

const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";
const T1 = "33333333-3333-3333-3333-333333333333";
const N1 = "44444444-4444-4444-4444-444444444444";
const N2 = "55555555-5555-5555-5555-555555555555";
const LONG = `${P2}-legacy`;

async function columnTypes(driver: Mysql2Driver): Promise<Record<string, string>> {
  const rows = await driver.all<{ TABLE_NAME: string; COLUMN_NAME: string; COLUMN_TYPE: string }>(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'um\\_%'`,
  );
  const byKey = new Map(rows.map((r) => [`${r.TABLE_NAME}.${r.COLUMN_NAME}`, r.COLUMN_TYPE]));
  return Object.fromEntries(COLUMNS.map(([t, c]) => [`${t}.${c}`, byKey.get(`${t}.${c}`)!]));
}

const allOf = (type: string) => Object.fromEntries(COLUMNS.map(([t, c]) => [`${t}.${c}`, type]));

/** Every foreign key of the database: `name: table(cols) → ref(cols) ON DELETE rule ON UPDATE rule`. */
async function foreignKeys(driver: Mysql2Driver): Promise<string[]> {
  const rows = await driver.all<{
    TABLE_NAME: string;
    CONSTRAINT_NAME: string;
    COLS: string;
    REFERENCED_TABLE_NAME: string;
    REFS: string;
    DELETE_RULE: string;
    UPDATE_RULE: string;
  }>(
    `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.REFERENCED_TABLE_NAME, r.DELETE_RULE, r.UPDATE_RULE,
            GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS COLS,
            GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS REFS
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE k.TABLE_SCHEMA = DATABASE()
      GROUP BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.REFERENCED_TABLE_NAME, r.DELETE_RULE, r.UPDATE_RULE`,
  );
  return rows
    .map(
      (r) =>
        `${r.CONSTRAINT_NAME}: ${r.TABLE_NAME}(${r.COLS}) → ${r.REFERENCED_TABLE_NAME}(${r.REFS}) ON DELETE ${r.DELETE_RULE} ON UPDATE ${r.UPDATE_RULE}`,
    )
    .toSorted();
}

const FOREIGN_KEYS = [
  "um_children(pairA,pairB) → um_parents(pairA,pairB) ON DELETE NO ACTION ON UPDATE NO ACTION",
  "um_children(parentId) → um_parents(id) ON DELETE CASCADE ON UPDATE NO ACTION",
  "um_links(parentId) → um_parents(id) ON DELETE NO ACTION ON UPDATE CASCADE",
  "um_links(tagId) → um_tags(id) ON DELETE NO ACTION ON UPDATE NO ACTION",
  "um_nodes(parentId) → um_nodes(id) ON DELETE NO ACTION ON UPDATE NO ACTION",
];

/** {@link foreignKeys} without the constraint names. */
const unnamed = (fks: string[]) => fks.map((fk) => fk.replace(/^[^:]+: /, "")).toSorted();

/** Every row of the `um_*` tables, in key order. */
async function rows(driver: Mysql2Driver): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of ["um_parents", "um_children", "um_tags", "um_links", "um_nodes"]) {
    out[table] = await driver.all(`SELECT * FROM \`${table}\` ORDER BY 1`);
  }
  return out;
}

async function seed(driver: Mysql2Driver, parentIds: string[]): Promise<void> {
  for (const [i, id] of parentIds.entries()) {
    await driver.exec(
      `INSERT INTO um_parents (id, pairA, pairB, name) VALUES ('${id}', '${id}', '${T1}', 'p${i}')`,
    );
    // only the first child references the composite key (its rule is NO ACTION)
    const pair = i === 0 ? `'${id}', '${T1}'` : "NULL, NULL";
    await driver.exec(
      `INSERT INTO um_children (parentId, pairA, pairB, note) VALUES ('${id}', ${pair}, 'c${i}')`,
    );
  }
  await driver.exec(`INSERT INTO um_tags (id, name) VALUES ('${T1}', 't')`);
  await driver.exec(`INSERT INTO um_links (parentId, tagId) VALUES ('${P1}', '${T1}')`);
  await driver.exec(`INSERT INTO um_nodes (id, parentId, name) VALUES ('${N1}', NULL, 'root')`);
  await driver.exec(`INSERT INTO um_nodes (id, parentId, name) VALUES ('${N2}', '${N1}', 'leaf')`);
}

/** Syncs `types` in a fresh space (a new deployment). */
function sync(driver: Mysql2Driver, types: unknown[]) {
  const space = new DbSpace(() => new MysqlAdapter(driver));
  return new SchemaSync(space).run(types as any[], { onError: "silent" });
}

/** Syncs and seeds the earlier layout; its constraints (names included). */
async function earlierLayout(driver: Mysql2Driver, parentIds: string[]): Promise<string[]> {
  const result = await sync(driver, oldTypes());
  expect(result.entries.flatMap((e) => e.errors)).toEqual([]);
  await seed(driver, parentIds);
  const named = await foreignKeys(driver);
  expect(unnamed(named)).toEqual(FOREIGN_KEYS);
  return named;
}

describe.skipIf(!reachable)(
  "[mysql live] uuid keys migrating from VARCHAR(255) to CHAR(36)",
  () => {
    let driver: Mysql2Driver;
    let named: string[];

    beforeAll(async () => {
      driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    });

    afterAll(async () => {
      await driver?.close();
      await dropMysqlDatabase(DB);
    });

    it("the earlier layout: VARCHAR(255) on both sides, every foreign key in place", async () => {
      named = await earlierLayout(driver, [P1, P2]);
      expect(await columnTypes(driver)).toEqual(allOf("varchar(255)"));
    });

    it("one sync makes every uuid key and foreign-key column CHAR(36), the constraints and rows kept", async () => {
      const before = await rows(driver);
      const result = await sync(driver, newTypes());
      expect(result.entries.flatMap((e) => e.errors.map((m) => `${e.name}: ${m}`))).toEqual([]);
      expect(result.status).toBe("synced");
      expect(await columnTypes(driver)).toEqual(allOf("char(36)"));
      // the same constraints: names, columns, ON DELETE / ON UPDATE rules
      expect(await foreignKeys(driver)).toEqual(named);
      expect(await rows(driver)).toEqual(before);
    });

    it("the re-created constraints are enforced, their rules kept", async () => {
      await expect(
        driver.exec(`INSERT INTO um_children (parentId, note) VALUES ('${N1}', 'orphan')`),
      ).rejects.toThrow();
      await expect(driver.exec(`DELETE FROM um_tags WHERE id = '${T1}'`)).rejects.toThrow();
      // ON DELETE CASCADE survived: P2's child goes with it
      await driver.exec(`DELETE FROM um_parents WHERE id = '${P2}'`);
      const left = await driver.all<{ parentId: string }>("SELECT parentId FROM um_children");
      expect(left.map((r) => r.parentId)).toEqual([P1]);
    });

    it("a second sync is up to date", async () => {
      const result = await new SchemaSync(new DbSpace(() => new MysqlAdapter(driver))).run(
        newTypes(),
      );
      expect(result.status).toBe("up-to-date");
    });
  },
);

describe.skipIf(!reachable)("[mysql live] a stored uuid key longer than 36 characters", () => {
  let driver: Mysql2Driver;
  let named: string[];

  beforeAll(async () => {
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB_LONG));
    named = await earlierLayout(driver, [P1, LONG]);
  });

  afterAll(async () => {
    await driver?.close();
    await dropMysqlDatabase(DB_LONG);
  });

  it("fails the sync of the tables holding it, never truncates, keeps every foreign key", async () => {
    const before = await rows(driver);
    const result = await sync(driver, newTypes());
    expect(result.status).toBe("failed");
    const failed = Object.fromEntries(
      result.entries.filter((e) => e.status === "error").map((e) => [e.name, e.errors.join(" ")]),
    );
    expect(Object.keys(failed).toSorted()).toEqual(["um_children", "um_parents"]);
    expect(failed.um_parents).toMatch(/Data too long/i);
    expect(await rows(driver)).toEqual(before);
    const types = await columnTypes(driver);
    expect(types["um_parents.id"]).toBe("varchar(255)");
    expect(types["um_children.parentId"]).toBe("varchar(255)");
    expect(await foreignKeys(driver)).toEqual(named);
  });

  it("a MODIFY failing after another one succeeded: the constraints are back, the rows unchanged", async () => {
    await driver.exec(`DELETE FROM um_children WHERE parentId = '${LONG}'`);
    await driver.exec(`DELETE FROM um_parents WHERE id = '${LONG}'`);
    // `id` converts, the long `pairA` (referenced by the composite key) does not
    await driver.exec(
      `INSERT INTO um_parents (id, pairA, pairB, name) VALUES ('${P2}', '${LONG}', '${T1}', 'p2')`,
    );
    const before = await rows(driver);
    const result = await sync(driver, newTypes());
    const failed = result.entries.filter((e) => e.status === "error").map((e) => e.name);
    expect(failed).toEqual(["um_parents"]);
    const types = await columnTypes(driver);
    expect(types["um_parents.id"]).toBe("char(36)");
    expect(types["um_parents.pairA"]).toBe("varchar(255)");
    expect(types["um_children.pairA"]).toBe("char(36)");
    expect(await foreignKeys(driver)).toEqual(named);
    expect(await rows(driver)).toEqual(before);
  });

  it("syncs once the long value is gone", async () => {
    await driver.exec(`UPDATE um_parents SET pairA = '${P2}' WHERE id = '${P2}'`);
    const result = await sync(driver, newTypes());
    expect(result.entries.flatMap((e) => e.errors.map((m) => `${e.name}: ${m}`))).toEqual([]);
    expect(await columnTypes(driver)).toEqual(allOf("char(36)"));
    expect(await foreignKeys(driver)).toEqual(named);
  });
});
