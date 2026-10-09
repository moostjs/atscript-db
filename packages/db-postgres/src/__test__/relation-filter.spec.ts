import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// Relational filter predicates ($some / $none), since 0.1.147: correlated
// [NOT] EXISTS subqueries; `?` placeholders finalize to `$N` in textual order.

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
  driver = createMockDriver({ getResult: { cnt: "0" } });
  space = new DbSpace(() => new PostgresAdapter(driver));
});

function t(type: unknown): any {
  return space.getTable(type as never);
}

const last = () => driver.calls.at(-1)!;

describe("[postgres] relational predicates", () => {
  it("advertises read and write support", () => {
    const adapter = t(fx.RfIssue).getAdapter() as PostgresAdapter;
    expect(adapter.supportsRelationFilters("read")).toBe(true);
    expect(adapter.supportsRelationFilters("write")).toBe(true);
  });

  it("to: schema-qualified target, $N numbering across the predicate", async () => {
    await t(fx.RfIssue).findMany({
      filter: {
        title: "before",
        ticket: { $some: { teamId: { $in: ["t1", "t2"] }, status: "open" } },
        id: { $gt: 3 },
      },
      controls: { $limit: 5 },
    });
    expect(last().sql).toBe(
      'SELECT * FROM "rf_issues" WHERE "title" = $1 AND EXISTS (SELECT 1 FROM "app"."rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref" AND "_rf1"."team_ref" IN ($2, $3) AND "_rf1"."status" = $4) AND "id" > $5 LIMIT $6',
    );
    expect(last().params).toEqual(["before", "t1", "t2", "open", 3, 5]);
  });

  it("from: the schema-qualified source is the outer qualifier", async () => {
    await t(fx.RfTicket).findMany({ filter: { issues: { $none: {} } }, controls: {} });
    expect(last().sql).toBe(
      'SELECT * FROM "app"."rf_tickets" WHERE NOT EXISTS (SELECT 1 FROM "rf_issues" AS "_rf1" WHERE "_rf1"."ticket_ref" = "app"."rf_tickets"."key")',
    );
  });

  it("via: junction joined to the target", async () => {
    await t(fx.RfTicket).findMany({ filter: { labels: { $some: { name: "bug" } } }, controls: {} });
    expect(last().sql).toBe(
      'SELECT * FROM "app"."rf_tickets" WHERE EXISTS (SELECT 1 FROM "rf_ticket_labels" AS "_rf1" JOIN "rf_labels" AS "_rf2" ON "_rf2"."id" = "_rf1"."labelId" WHERE "_rf1"."ticketKey" = "app"."rf_tickets"."key" AND "_rf2"."label_name" = $1)',
    );
    expect(last().params).toEqual(["bug"]);
  });

  it("nested predicate in count", async () => {
    await t(fx.RfIssue).count({
      filter: { ticket: { $some: { team: { $some: { name: "Core" } } } } },
    });
    expect(last().sql).toBe(
      'SELECT COUNT(*) as cnt FROM "rf_issues" WHERE EXISTS (SELECT 1 FROM "app"."rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref" AND EXISTS (SELECT 1 FROM "rf_teams" AS "_rf2" WHERE "_rf2"."id" = "_rf1"."team_ref" AND "_rf2"."name" = $1))',
    );
  });

  it("self-referencing updateMany needs no rewrite", async () => {
    await t(fx.RfTicket).updateMany({ parent: { $some: { status: "open" } } }, { status: "x" });
    expect(last().sql).toBe(
      'UPDATE "app"."rf_tickets" SET "status" = $1 WHERE EXISTS (SELECT 1 FROM "app"."rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "app"."rf_tickets"."parentKey" AND "_rf1"."status" = $2)',
    );
    expect(last().params).toEqual(["x", "open"]);
  });

  it("deleteOne repeats the filter (PK re-keying) with distinct $N", async () => {
    const tickets = t(fx.RfTicket);
    const q = tickets._translateForAdapter({ filter: { parent: { $some: { status: "open" } } } });
    await (tickets.getAdapter() as PostgresAdapter).deleteOne(q.filter);
    const sub =
      'EXISTS (SELECT 1 FROM "app"."rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "app"."rf_tickets"."parentKey" AND "_rf1"."status" = $N)';
    expect(last().sql).toBe(
      `DELETE FROM "app"."rf_tickets" WHERE ${sub.replace("$N", "$1")} AND "key" = (SELECT "key" FROM "app"."rf_tickets" WHERE ${sub.replace("$N", "$2")} LIMIT 1)`,
    );
    expect(last().params).toEqual(["open", "open"]);
  });

  it("text search (unaliased FROM) + predicate", async () => {
    await t(fx.RfTicket).search("crash", { filter: { issues: { $some: {} } }, controls: {} });
    expect(last().sql).toContain(
      'WHERE EXISTS (SELECT 1 FROM "rf_issues" AS "_rf1" WHERE "_rf1"."ticket_ref" = "app"."rf_tickets"."key") AND to_tsvector(',
    );
  });

  it("geo search correlates to the `t` alias", async () => {
    const tickets = t(fx.RfTicket);
    await tickets.ensureTable();
    driver.calls.length = 0;
    await tickets.geoSearchWithCount(SF, { filter: { issues: { $some: {} } }, controls: {} });
    const sqls = driver.calls.map((c) => c.sql);
    expect(sqls).toHaveLength(2);
    for (const sql of sqls) {
      expect(sql).toContain(
        'AS "t" WHERE EXISTS (SELECT 1 FROM "rf_issues" AS "_rf1" WHERE "_rf1"."ticket_ref" = "t"."key")',
      );
    }
  });

  it("vector search correlates to the `t` alias", async () => {
    const notes = t(fx.RfNote);
    await notes.ensureTable();
    driver.calls.length = 0;
    await notes.vectorSearch(VEC, {
      filter: { ticket: { $some: { status: "open" } } },
      controls: {},
    });
    expect(last().sql).toContain(
      'AS "t" WHERE EXISTS (SELECT 1 FROM "app"."rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "t"."ticketKey" AND "_rf1"."status" = $2)',
    );
    expect(last().params?.[1]).toBe("open");
  });

  it("grouped aggregate keeps the predicate in WHERE", async () => {
    await t(fx.RfTicket).aggregate({
      filter: { parent: { $none: {} } },
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "count", $field: "*", $as: "n" }] as any,
      },
    });
    expect(last().sql).toContain(
      'FROM "app"."rf_tickets" WHERE NOT EXISTS (SELECT 1 FROM "app"."rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "app"."rf_tickets"."parentKey") GROUP BY "status"',
    );
  });
});

describe("[postgres] @db.column-renamed FK / PK columns (since 0.1.147)", () => {
  const createOf = (table: string) =>
    driver.calls.find(
      (c) => c.method === "exec" && c.sql.includes(`CREATE TABLE IF NOT EXISTS "${table}"`),
    )!.sql;

  it("FOREIGN KEY names the physical local and referenced columns", async () => {
    await t(fx.RfIssue).ensureTable();
    await t(fx.RfTagUse).ensureTable();
    expect(createOf("rf_issues")).toContain(
      'FOREIGN KEY ("ticket_ref") REFERENCES "app"."rf_tickets" ("key")',
    );
    expect(createOf("rf_tag_uses")).toContain(
      'FOREIGN KEY ("tag_ref") REFERENCES "rf_tags" ("tag_code") ON DELETE CASCADE',
    );
  });

  it("syncForeignKeys adds the constraint on the physical columns", async () => {
    await t(fx.RfTagUse).getAdapter().syncForeignKeys();
    expect(driver.calls.at(-1)!.sql).toBe(
      'ALTER TABLE "rf_tag_uses" ADD FOREIGN KEY ("tag_ref") REFERENCES "rf_tags" ("tag_code") ON DELETE CASCADE',
    );
  });

  const stmt = (prefix: string) => driver.calls.find((c) => c.sql.startsWith(prefix))?.sql;

  it("updateOne / deleteOne key on the physical primary key", async () => {
    // An exact PK filter pins the row by itself (no LIMIT 1 subquery, since 0.1.151).
    await t(fx.RfTag).updateOne({ code: "a", label: "A" });
    expect(stmt('UPDATE "rf_tags"')).toBe(
      'UPDATE "rf_tags" SET "label" = $1 WHERE "tag_code" = $2',
    );
    await t(fx.RfTag).deleteOne("a");
    expect(stmt('DELETE FROM "rf_tags"')).toBe('DELETE FROM "rf_tags" WHERE "tag_code" = $1');
    // Any other filter re-keys on the physical PK through the subquery.
    driver.calls.length = 0;
    await t(fx.RfTag).getAdapter().updateOne({ label: "A" }, { label: "B" });
    expect(stmt('UPDATE "rf_tags"')).toBe(
      'UPDATE "rf_tags" SET "label" = $1 WHERE "tag_code" = (SELECT "tag_code" FROM "rf_tags" WHERE "label" = $2 LIMIT 1)',
    );
    await t(fx.RfTag).getAdapter().deleteOne({ label: "A" });
    expect(stmt('DELETE FROM "rf_tags"')).toBe(
      'DELETE FROM "rf_tags" WHERE "label" = $1 AND "tag_code" = (SELECT "tag_code" FROM "rf_tags" WHERE "label" = $2 LIMIT 1)',
    );
  });

  it("insertOne / insertMany return the physical primary key", async () => {
    await t(fx.RfTag).insertOne({ code: "a", label: "A" });
    expect(stmt('INSERT INTO "rf_tags"')).toMatch(/ RETURNING "tag_code"$/);
    driver.calls.length = 0;
    await t(fx.RfTag).insertMany([
      { code: "b", label: "B" },
      { code: "c", label: "C" },
    ]);
    expect(stmt('INSERT INTO "rf_tags"')).toMatch(/ RETURNING "tag_code"$/);
  });
});
