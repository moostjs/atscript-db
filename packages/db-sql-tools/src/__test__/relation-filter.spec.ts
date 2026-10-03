import { describe, it, expect } from "vite-plus/test";
import { ResolvedRelationFilter, UniquSelect, type BaseDbAdapter } from "@atscript/db";
import type { FilterExpr } from "@uniqu/core";

import { buildWhere, createFilterVisitor } from "../filter-builder";
import { finalizeParams } from "../dialect";
import type { SqlDialect } from "../dialect";
import { buildDelete, buildSelect, buildUpdate } from "../sql-builder";
import { buildAggregateSelect } from "../agg";

// Relational predicates ($some / $none), since 0.1.147: a resolved predicate
// renders as a correlated [NOT] EXISTS subquery.

const dialect: SqlDialect = {
  quoteIdentifier: (name) => `"${name}"`,
  quoteTable: (name) =>
    name
      .split(".")
      .map((p) => `"${p}"`)
      .join("."),
  unlimitedLimit: "-1",
  toValue: (v) => v,
  toParam: (v) => (typeof v === "boolean" ? (v ? 1 : 0) : v),
  regex: (col, v) => ({ sql: `${col} LIKE ?`, params: [String(v)] }),
  createViewPrefix: "CREATE VIEW",
};

const pgLike: SqlDialect = { ...dialect, paramPlaceholder: (i) => `$${i}` };

const adapter = {} as BaseDbAdapter;
const table = (name: string) => ({ table: name, name: name.split(".").pop()!, adapter });

function to(
  source: string,
  target: string,
  pairs: Array<{ source: string; target: string }>,
  filter: FilterExpr = {},
  nav = "rel",
) {
  return new ResolvedRelationFilter({
    kind: "to",
    nav,
    source: table(source),
    target: table(target),
    pairs,
    filter,
  });
}

const ticketOfIssue = (filter: FilterExpr = {}) =>
  to("rf_issues", "rf_tickets", [{ source: "ticket_ref", target: "key" }], filter, "ticket");

const teamOfTicket = (filter: FilterExpr = {}) =>
  to("rf_tickets", "rf_teams", [{ source: "team_ref", target: "id" }], filter, "team");

const labelsOfTicket = (filter: FilterExpr = {}, junctionFilter?: FilterExpr) =>
  new ResolvedRelationFilter({
    kind: "via",
    nav: "labels",
    source: table("rf_tickets"),
    target: table("rf_labels"),
    pairs: [],
    junction: {
      ...table("rf_ticket_labels"),
      toSource: [{ junction: "ticketKey", source: "key" }],
      toTarget: [{ junction: "labelId", target: "id" }],
      ...(junctionFilter ? { filter: junctionFilter } : {}),
    },
    filter,
  });

describe("relational predicates — SQL rendering", () => {
  it("to: EXISTS correlated on the qualified source FK", () => {
    const result = buildWhere(dialect, {
      ticket: { $some: ticketOfIssue({ team_ref: { $in: ["t1", "t2"] }, status: "open" }) },
    } as FilterExpr);
    expect(result.sql).toBe(
      'EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref" AND "_rf1"."team_ref" IN (?, ?) AND "_rf1"."status" = ?)',
    );
    expect(result.params).toEqual(["t1", "t2", "open"]);
  });

  it("$some: {} renders the correlation only", () => {
    const result = buildWhere(dialect, { ticket: { $some: ticketOfIssue() } } as FilterExpr);
    expect(result).toEqual({
      sql: 'EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref")',
      params: [],
    });
  });

  it("$none renders NOT EXISTS", () => {
    const result = buildWhere(dialect, {
      ticket: { $none: ticketOfIssue({ status: "open" }) },
    } as FilterExpr);
    expect(result).toEqual({
      sql: 'NOT EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref" AND "_rf1"."status" = ?)',
      params: ["open"],
    });
  });

  it("$some and $none on one key are ANDed", () => {
    const result = buildWhere(dialect, {
      ticket: { $some: ticketOfIssue({ status: "open" }), $none: ticketOfIssue({ team_ref: "x" }) },
    } as FilterExpr);
    expect(result.sql).toBe(
      'EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref" AND "_rf1"."status" = ?) AND NOT EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf2" WHERE "_rf2"."key" = "rf_issues"."ticket_ref" AND "_rf2"."team_ref" = ?)',
    );
    expect(result.params).toEqual(["open", "x"]);
  });

  it("from: the FK lives on the target", () => {
    const node = new ResolvedRelationFilter({
      kind: "from",
      nav: "issues",
      source: table("rf_tickets"),
      target: table("rf_issues"),
      pairs: [{ source: "key", target: "ticket_ref" }],
      filter: { title: { $regex: "crash" } },
    });
    const result = buildWhere(dialect, { issues: { $some: node } } as FilterExpr);
    expect(result).toEqual({
      sql: 'EXISTS (SELECT 1 FROM "rf_issues" AS "_rf1" WHERE "_rf1"."ticket_ref" = "rf_tickets"."key" AND "_rf1"."title" LIKE ?)',
      params: ["crash"],
    });
  });

  it("via: junction joined to the target, junction filter on the junction alias", () => {
    const result = buildWhere(dialect, {
      labels: { $some: labelsOfTicket({ label_name: "bug" }, { pinned: true }) },
    } as FilterExpr);
    expect(result).toEqual({
      sql: 'EXISTS (SELECT 1 FROM "rf_ticket_labels" AS "_rf1" JOIN "rf_labels" AS "_rf2" ON "_rf2"."id" = "_rf1"."labelId" WHERE "_rf1"."ticketKey" = "rf_tickets"."key" AND "_rf1"."pinned" = ? AND "_rf2"."label_name" = ?)',
      params: [1, "bug"],
    });
  });

  it("via: $none {} without a junction filter", () => {
    const result = buildWhere(dialect, { labels: { $none: labelsOfTicket() } } as FilterExpr);
    expect(result.sql).toBe(
      'NOT EXISTS (SELECT 1 FROM "rf_ticket_labels" AS "_rf1" JOIN "rf_labels" AS "_rf2" ON "_rf2"."id" = "_rf1"."labelId" WHERE "_rf1"."ticketKey" = "rf_tickets"."key")',
    );
  });

  it("composite keys: one equality per pair", () => {
    const node = to(
      "rf_cards",
      "rf_boards",
      [
        { source: "boardOrg", target: "org" },
        { source: "boardCode", target: "code" },
      ],
      { title: "x" },
      "board",
    );
    const result = buildWhere(dialect, { board: { $some: node } } as FilterExpr);
    expect(result.sql).toBe(
      'EXISTS (SELECT 1 FROM "rf_boards" AS "_rf1" WHERE "_rf1"."org" = "rf_cards"."boardOrg" AND "_rf1"."code" = "rf_cards"."boardCode" AND "_rf1"."title" = ?)',
    );
  });

  it("self relation: the outer reference is qualified with the source table", () => {
    const node = to(
      "rf_tickets",
      "rf_tickets",
      [{ source: "parentKey", target: "key" }],
      { status: "open" },
      "parent",
    );
    const result = buildWhere(dialect, { parent: { $some: node } } as FilterExpr);
    expect(result.sql).toBe(
      'EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_tickets"."parentKey" AND "_rf1"."status" = ?)',
    );
  });

  it("nested two levels: the inner predicate correlates to its parent alias", () => {
    const result = buildWhere(dialect, {
      ticket: { $some: ticketOfIssue({ team: { $some: teamOfTicket({ name: "Core" }) } }) },
    } as FilterExpr);
    expect(result).toEqual({
      sql: 'EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref" AND EXISTS (SELECT 1 FROM "rf_teams" AS "_rf2" WHERE "_rf2"."id" = "_rf1"."team_ref" AND "_rf2"."name" = ?))',
      params: ["Core"],
    });
  });

  it("nested via inside to: the junction correlates to the parent alias", () => {
    const result = buildWhere(dialect, {
      ticket: { $none: ticketOfIssue({ labels: { $some: labelsOfTicket({ label_name: "x" }) } }) },
    } as FilterExpr);
    expect(result.sql).toBe(
      'NOT EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref" AND EXISTS (SELECT 1 FROM "rf_ticket_labels" AS "_rf2" JOIN "rf_labels" AS "_rf3" ON "_rf3"."id" = "_rf2"."labelId" WHERE "_rf2"."ticketKey" = "_rf1"."key" AND "_rf3"."label_name" = ?))',
    );
  });

  it("predicate inside $or and an inner $or", () => {
    const result = buildWhere(dialect, {
      $or: [
        { title: "a" },
        { ticket: { $some: ticketOfIssue({ $or: [{ status: "open" }, { status: "new" }] }) } },
      ],
    } as FilterExpr);
    expect(result).toEqual({
      sql: '("title" = ? OR EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref" AND ("_rf1"."status" = ? OR "_rf1"."status" = ?)))',
      params: ["a", "open", "new"],
    });
  });

  it("$not around a predicate", () => {
    const result = buildWhere(dialect, {
      $not: { ticket: { $some: ticketOfIssue({ status: "open" }) } },
    } as FilterExpr);
    expect(result.sql).toBe(
      'NOT (EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref" AND "_rf1"."status" = ?))',
    );
  });

  it("qualifier override: the outer reference uses the given alias", () => {
    const result = buildWhere(dialect, { ticket: { $some: ticketOfIssue() } } as FilterExpr, {
      columnRef: (c) => `t."${c}"`,
      qualifier: "t",
    });
    expect(result.sql).toBe(
      'EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = t."ticket_ref")',
    );
  });

  it("qualifier override with columnRef: plain columns stay prefixed, subquery alias does not", () => {
    const result = buildWhere(
      dialect,
      { title: "x", ticket: { $some: ticketOfIssue({ status: "open" }) } } as FilterExpr,
      { columnRef: (c) => `t."${c}"`, qualifier: "t" },
    );
    expect(result.sql).toBe(
      't."title" = ? AND EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = t."ticket_ref" AND "_rf1"."status" = ?)',
    );
  });

  it("schema-qualified tables render through quoteTable", () => {
    const node = to("app.rf_issues", "app.rf_tickets", [{ source: "ticket_ref", target: "key" }]);
    const result = buildWhere(dialect, { ticket: { $some: node } } as FilterExpr);
    expect(result.sql).toBe(
      'EXISTS (SELECT 1 FROM "app"."rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "app"."rf_issues"."ticket_ref")',
    );
  });

  it("params follow textual order: before, inside and after a predicate", () => {
    const result = buildWhere(dialect, {
      title: "before",
      ticket: { $some: ticketOfIssue({ status: "inside", team_ref: { $in: ["a", "b"] } }) },
      id: { $gt: 5 },
    } as FilterExpr);
    expect(result.params).toEqual(["before", "inside", "a", "b", 5]);
    const select = buildSelect(pgLike, "rf_issues", result, { $limit: 10 } as never);
    expect(select.sql).toBe(
      'SELECT * FROM "rf_issues" WHERE "title" = $1 AND EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref" AND "_rf1"."status" = $2 AND "_rf1"."team_ref" IN ($3, $4)) AND "id" > $5 LIMIT $6',
    );
    expect(select.params).toEqual(["before", "inside", "a", "b", 5, 10]);
    expect(finalizeParams(pgLike, result).sql.match(/\$\d/g)).toEqual([
      "$1",
      "$2",
      "$3",
      "$4",
      "$5",
    ]);
  });

  it("each buildWhere call restarts the alias sequence", () => {
    const filter = { ticket: { $some: ticketOfIssue() } } as FilterExpr;
    expect(buildWhere(dialect, filter).sql).toBe(buildWhere(dialect, filter).sql);
  });

  it("predicate-free output is unchanged (with and without options)", () => {
    const filter = { a: 1, $or: [{ b: { $in: [1, 2] } }, { c: null }] } as FilterExpr;
    expect(buildWhere(dialect, filter)).toEqual({
      sql: '"a" = ? AND ("b" IN (?, ?) OR "c" IS NULL)',
      params: [1, 1, 2],
    });
    expect(buildWhere(dialect, filter, { columnRef: (c) => `t."${c}"` }).sql).toBe(
      't."a" = ? AND (t."b" IN (?, ?) OR t."c" IS NULL)',
    );
  });

  it("an unresolved operand fails loudly", () => {
    expect(() =>
      buildWhere(dialect, { ticket: { $some: { status: "open" } } } as FilterExpr),
    ).toThrow(expect.objectContaining({ code: "REL_FILTER_NOT_SUPPORTED" }));
  });

  it("createFilterVisitor exposes the relation callback", () => {
    const visitor = createFilterVisitor(dialect, { qualifier: '"x"' });
    expect(visitor.relation!("ticket", "$some", ticketOfIssue() as never).sql).toBe(
      'EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "x"."ticket_ref")',
    );
  });
});

describe("relational predicates in the shared statement builders", () => {
  const where = () =>
    buildWhere(dialect, { ticket: { $some: ticketOfIssue({ status: "open" }) } } as FilterExpr);

  it("UPDATE / DELETE correlate to the bare statement table", () => {
    const update = buildUpdate(
      pgLike,
      "app.rf_issues",
      { title: "x" },
      buildWhere(pgLike, {
        ticket: {
          $some: to("app.rf_issues", "app.rf_tickets", [{ source: "ticket_ref", target: "key" }], {
            status: "open",
          }),
        },
      } as FilterExpr),
    );
    expect(update.sql).toBe(
      'UPDATE "app"."rf_issues" SET "title" = $1 WHERE EXISTS (SELECT 1 FROM "app"."rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "app"."rf_issues"."ticket_ref" AND "_rf1"."status" = $2)',
    );
    expect(update.params).toEqual(["x", "open"]);
    const del = buildDelete(dialect, "rf_issues", where());
    expect(del.sql).toBe(
      'DELETE FROM "rf_issues" WHERE EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref" AND "_rf1"."status" = ?)',
    );
  });

  it("grouped aggregate keeps the predicate in WHERE", () => {
    const agg = buildAggregateSelect(dialect, "rf_issues", where(), {
      $groupBy: ["title"],
      $select: new UniquSelect(["title", { $fn: "count", $field: "*" }] as never),
    } as never);
    expect(agg.sql).toContain(
      'FROM "rf_issues" WHERE EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref" AND "_rf1"."status" = ?) GROUP BY "title"',
    );
    expect(agg.params).toEqual(["open"]);
  });
});
