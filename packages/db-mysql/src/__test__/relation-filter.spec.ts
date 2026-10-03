import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// Relational filter predicates ($some / $none), since 0.1.147: correlated
// [NOT] EXISTS subqueries; an UPDATE / DELETE whose predicate reads the
// mutated table itself is re-keyed through a materialized derived table
// (MySQL error 1093, ER_UPDATE_TABLE_USED).

const SF: [number, number] = [-122.42, 37.77];
const VEC = Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0));

let fx: Record<string, any>;
let driver: ReturnType<typeof createMockDriver>;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rel-filter.as");
});

beforeEach(() => {
  driver = createMockDriver({
    get: [
      ["VERSION()", { v: "9.1.0" }],
      ["COUNT(*)", { cnt: 0 }],
    ],
  });
  space = new DbSpace(() => new MysqlAdapter(driver));
});

function t(type: unknown): any {
  return space.getTable(type as never);
}

const last = () => driver.calls.at(-1)!;

/** `EXISTS` of the `parent` self relation on tickets, correlated to the bare table. */
const PARENT_OPEN =
  "EXISTS (SELECT 1 FROM `app`.`rf_tickets` AS `_rf1` WHERE `_rf1`.`key` = `app`.`rf_tickets`.`parentKey` AND `_rf1`.`status` = ?)";

describe("[mysql] relational predicates — reads", () => {
  it("advertises read and write support", () => {
    const adapter = t(fx.RfIssue).getAdapter() as MysqlAdapter;
    expect(adapter.supportsRelationFilters("read")).toBe(true);
    expect(adapter.supportsRelationFilters("write")).toBe(true);
  });

  it("to: schema-qualified target, params in textual order", async () => {
    await t(fx.RfIssue).findMany({
      filter: {
        title: "before",
        ticket: { $some: { teamId: { $in: ["t1", "t2"] }, status: "open" } },
      },
      controls: { $limit: 5 },
    });
    expect(last().sql).toBe(
      "SELECT * FROM `rf_issues` WHERE `title` = ? AND EXISTS (SELECT 1 FROM `app`.`rf_tickets` AS `_rf1` WHERE `_rf1`.`key` = `rf_issues`.`ticket_ref` AND `_rf1`.`team_ref` IN (?, ?) AND `_rf1`.`status` = ?) LIMIT ?",
    );
    expect(last().params).toEqual(["before", "t1", "t2", "open", 5]);
  });

  it("from and via", async () => {
    const tickets = t(fx.RfTicket);
    await tickets.findMany({ filter: { issues: { $none: {} } }, controls: {} });
    expect(last().sql).toBe(
      "SELECT * FROM `app`.`rf_tickets` WHERE NOT EXISTS (SELECT 1 FROM `rf_issues` AS `_rf1` WHERE `_rf1`.`ticket_ref` = `app`.`rf_tickets`.`key`)",
    );
    await tickets.findMany({ filter: { labels: { $some: { name: "bug" } } }, controls: {} });
    expect(last().sql).toBe(
      "SELECT * FROM `app`.`rf_tickets` WHERE EXISTS (SELECT 1 FROM `rf_ticket_labels` AS `_rf1` JOIN `rf_labels` AS `_rf2` ON `_rf2`.`id` = `_rf1`.`labelId` WHERE `_rf1`.`ticketKey` = `app`.`rf_tickets`.`key` AND `_rf2`.`label_name` = ?)",
    );
  });

  it("a self-referencing read is not rewritten", async () => {
    await t(fx.RfTicket).findMany({
      filter: { parent: { $some: { status: "open" } } },
      controls: {},
    });
    expect(last().sql).toBe(`SELECT * FROM \`app\`.\`rf_tickets\` WHERE ${PARENT_OPEN}`);
  });

  it("geo and vector search correlate to the `t` alias", async () => {
    const tickets = t(fx.RfTicket);
    await tickets.ensureTable();
    driver.calls.length = 0;
    await tickets.geoSearch(SF, { filter: { issues: { $some: {} } }, controls: {} });
    expect(last().sql).toContain(
      "AS `t` WHERE EXISTS (SELECT 1 FROM `rf_issues` AS `_rf1` WHERE `_rf1`.`ticket_ref` = `t`.`key`)",
    );

    const notes = t(fx.RfNote);
    await notes.ensureTable();
    driver.calls.length = 0;
    await notes.vectorSearch(VEC, { filter: { ticket: { $none: {} } }, controls: {} });
    expect(last().sql).toContain(
      "AS `t` WHERE NOT EXISTS (SELECT 1 FROM `app`.`rf_tickets` AS `_rf1` WHERE `_rf1`.`key` = `t`.`ticketKey`)",
    );
  });
});

describe("[mysql] relational predicates — 1093 rewrite", () => {
  it("updateMany on a self-referencing predicate re-keys through a derived table", async () => {
    await t(fx.RfTicket).updateMany({ parent: { $some: { status: "open" } } }, { status: "x" });
    expect(last().sql).toBe(
      `UPDATE \`app\`.\`rf_tickets\` SET \`status\` = ? WHERE \`key\` IN (SELECT * FROM (SELECT DISTINCT \`key\` FROM \`app\`.\`rf_tickets\` WHERE ${PARENT_OPEN}) AS \`_rfm\`)`,
    );
    expect(last().params).toEqual(["x", "open"]);
  });

  it("deleteMany with a composite primary key", async () => {
    await t(fx.RfBoard).deleteMany({ parentBoard: { $none: {} } });
    expect(last().sql).toBe(
      "DELETE FROM `rf_boards` WHERE (`org`, `code`) IN (SELECT * FROM (SELECT DISTINCT `org`, `code` FROM `rf_boards` WHERE NOT EXISTS (SELECT 1 FROM `rf_boards` AS `_rf1` WHERE `_rf1`.`org` = `rf_boards`.`parentOrg` AND `_rf1`.`code` = `rf_boards`.`parentCode`)) AS `_rfm`)",
    );
  });

  it("a nested predicate reading the mutated table also triggers the rewrite", async () => {
    await t(fx.RfIssue).updateMany(
      { ticket: { $some: { issues: { $some: { title: "dup" } } } } },
      { title: "x" },
    );
    expect(last().sql).toBe(
      "UPDATE `rf_issues` SET `title` = ? WHERE `id` IN (SELECT * FROM (SELECT DISTINCT `id` FROM `rf_issues` WHERE EXISTS (SELECT 1 FROM `app`.`rf_tickets` AS `_rf1` WHERE `_rf1`.`key` = `rf_issues`.`ticket_ref` AND EXISTS (SELECT 1 FROM `rf_issues` AS `_rf2` WHERE `_rf2`.`ticket_ref` = `_rf1`.`key` AND `_rf2`.`title` = ?))) AS `_rfm`)",
    );
    expect(last().params).toEqual(["x", "dup"]);
  });

  it("single-row update / delete keep LIMIT 1 on the outer statement", async () => {
    const tickets = t(fx.RfTicket);
    const adapter = tickets.getAdapter() as MysqlAdapter;
    const q = tickets._translateForAdapter({ filter: { parent: { $some: { status: "open" } } } });
    const rewritten = `\`key\` IN (SELECT * FROM (SELECT DISTINCT \`key\` FROM \`app\`.\`rf_tickets\` WHERE ${PARENT_OPEN}) AS \`_rfm\`)`;

    await adapter.updateOne(q.filter, { status: "x" });
    expect(last().sql).toBe(
      `UPDATE \`app\`.\`rf_tickets\` SET \`status\` = ? WHERE ${rewritten} LIMIT 1`,
    );
    await adapter.replaceOne(q.filter, { key: "K9", title: "t", status: "x" });
    expect(last().sql).toMatch(
      /^UPDATE `app`\.`rf_tickets` SET .* WHERE `key` IN \(SELECT \* FROM/,
    );
    expect(last().sql.endsWith(" LIMIT 1")).toBe(true);

    await adapter.deleteOne(q.filter);
    expect(last().sql).toBe(`DELETE FROM \`app\`.\`rf_tickets\` WHERE ${rewritten} LIMIT 1`);
    expect(last().params).toEqual(["open"]);
  });

  it("no rewrite when the predicate reads other tables only", async () => {
    await t(fx.RfIssue).updateMany({ ticket: { $some: { status: "closed" } } }, { title: "x" });
    expect(last().sql).toBe(
      "UPDATE `rf_issues` SET `title` = ? WHERE EXISTS (SELECT 1 FROM `app`.`rf_tickets` AS `_rf1` WHERE `_rf1`.`key` = `rf_issues`.`ticket_ref` AND `_rf1`.`status` = ?)",
    );
    await t(fx.RfIssue).deleteMany({ title: "plain" });
    expect(last().sql).toBe("DELETE FROM `rf_issues` WHERE `title` = ?");
  });
});

describe("[mysql] @db.column-renamed FK / PK columns (since 0.1.147)", () => {
  const stmt = (prefix: string) => driver.calls.find((c) => c.sql.startsWith(prefix))?.sql;

  it("FOREIGN KEY names the physical local and referenced columns", async () => {
    await t(fx.RfIssue).ensureTable();
    await t(fx.RfTagUse).ensureTable();
    expect(stmt("CREATE TABLE IF NOT EXISTS `rf_issues`")).toContain(
      "FOREIGN KEY (`ticket_ref`) REFERENCES `app`.`rf_tickets` (`key`)",
    );
    expect(stmt("CREATE TABLE IF NOT EXISTS `rf_tag_uses`")).toContain(
      "FOREIGN KEY (`tag_ref`) REFERENCES `rf_tags` (`tag_code`) ON DELETE CASCADE",
    );
  });

  it("syncForeignKeys adds the constraint on the physical columns", async () => {
    await t(fx.RfTagUse).getAdapter().syncForeignKeys();
    expect(stmt("ALTER TABLE `rf_tag_uses` ADD FOREIGN KEY")).toBe(
      "ALTER TABLE `rf_tag_uses` ADD FOREIGN KEY (`tag_ref`) REFERENCES `rf_tags` (`tag_code`) ON DELETE CASCADE",
    );
  });

  it("updateOne / deleteOne filter on the physical primary key", async () => {
    await t(fx.RfTag).updateOne({ code: "a", label: "A" });
    expect(stmt("UPDATE `rf_tags`")).toBe(
      "UPDATE `rf_tags` SET `label` = ? WHERE `tag_code` = ? LIMIT 1",
    );
    await t(fx.RfTag).deleteOne("a");
    expect(stmt("DELETE FROM `rf_tags`")).toBe(
      "DELETE FROM `rf_tags` WHERE `tag_code` = ? LIMIT 1",
    );
  });
});
