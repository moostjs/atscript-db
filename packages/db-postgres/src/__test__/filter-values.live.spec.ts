import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";

// Live DDL against a real server is slow under the parallel workspace run.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise (CI has no server). Override the server with
// `ATSCRIPT_PG_TEST_URL` (an admin connection; the spec creates and drops its
// own `typefix_filter_values` database).
//
// Filter values checked against the column type (since 0.1.147): a value
// that cannot denote the type is INVALID_QUERY with the field as path —
// never `invalid input syntax for type double precision` — on tables, view
// aggregate / computed columns, relational predicate operands, $having and
// mutation filters; every valid form still answers.

const DB = "typefix_filter_values";

const reachable = await pgReachable();

let fx: Record<string, any>;
let driver: PgDriver;
let space: DbSpace;

const t = (type: unknown): any => space.getTable(type as never);

async function invalid(promise: Promise<unknown>, path: string) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e as { code: string; errors: Array<{ path: string; message: string }> },
  );
  expect(err?.code).toBe("INVALID_QUERY");
  expect(err!.errors[0]!.path).toBe(path);
  expect(err!.errors[0]!.message).toContain("Invalid filter value");
}

async function ids(type: unknown, filter: Record<string, unknown>) {
  const rows = await t(type).findMany({ filter, controls: { $sort: { id: 1 } } });
  return rows.map((r: Record<string, unknown>) => r.id);
}

describe.skipIf(!reachable)("[postgres live] filter values checked against the column type", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/typefix.as");
    driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
    space = new DbSpace(() => new PostgresAdapter(driver));
    const result = await new SchemaSync(space).run([fx.TfTicket, fx.TfIssue, fx.TfTicketStats], {
      force: true,
    });
    expect(result.status).toBe("synced");
    await t(fx.TfTicket).insertMany([
      { id: 1, title: "A" },
      { id: 2, title: "B" },
    ]);
    await t(fx.TfIssue).insertMany([
      { id: 1, ticketId: 1, n: 0, ts: 1000, flag: false, label: "a", price: "1.50" },
      { id: 2, ticketId: 1, n: 5, ts: 2000, flag: true, label: "b", price: "12.50" },
    ]);
  });

  afterAll(async () => {
    await driver?.close();
    await dropPgDatabase(DB);
  });

  it("rejects values that cannot denote the column type", async () => {
    const issues = t(fx.TfIssue);
    await invalid(issues.findMany({ filter: { n: "x" } }), "n");
    await invalid(issues.findMany({ filter: { n: { $gte: "abc" } } }), "n");
    await invalid(issues.count({ filter: { n: { $in: [0, "abc"] } } }), "n");
    await invalid(issues.findMany({ filter: { ts: { $gte: "2026-01-01T00:00:00Z" } } }), "ts");
    await invalid(issues.findMany({ filter: { ts: { $gt: 1500.5 } } }), "ts");
    await invalid(issues.findMany({ filter: { flag: "yes" } }), "flag");
    await invalid(issues.findMany({ filter: { price: "abc" } }), "price");
  });

  it("view aggregate and computed columns", async () => {
    const stats = t(fx.TfTicketStats);
    await invalid(stats.findMany({ filter: { total: "x" } }), "total");
    await invalid(stats.findMany({ filter: { rank: { $gte: "abc" } } }), "rank");
    await invalid(stats.findMany({ filter: { issueCount: "x" } }), "issueCount");
    // A count is an integer column (PostgreSQL: `invalid input syntax for type bigint`).
    await invalid(stats.findMany({ filter: { issueCount: { $gt: 0.5 } } }), "issueCount");
  });

  it("relational predicate operands, $having and mutation filters", async () => {
    await invalid(
      t(fx.TfTicket).findMany({ filter: { issues: { $some: { n: "x" } } } }),
      "issues.n",
    );
    const issues = t(fx.TfIssue);
    await invalid(
      issues.aggregate({
        filter: {},
        controls: {
          $groupBy: ["label"],
          $select: ["label", { $fn: "sum", $field: "n", $as: "s" }],
          $having: { s: "x" },
        },
      }),
      "s",
    );
    await invalid(issues.deleteMany({ n: "x" }), "n");
    await invalid(issues.updateMany({ flag: "x" }, { label: "z" }), "flag");
    expect(await ids(fx.TfIssue, {})).toEqual([1, 2]);
    expect(await ids(fx.TfIssue, { label: "z" })).toEqual([]);
  });

  it("valid forms still answer", async () => {
    expect(await ids(fx.TfIssue, { n: 5 })).toEqual([2]);
    expect(await ids(fx.TfIssue, { n: { $gte: 5 } })).toEqual([2]);
    expect(await ids(fx.TfIssue, { n: { $in: [0, 5] } })).toEqual([1, 2]);
    expect(await ids(fx.TfIssue, { n: null })).toEqual([]);
    expect(await ids(fx.TfIssue, { n: { $ne: null } })).toEqual([1, 2]);
    expect(await ids(fx.TfIssue, { ts: { $gte: 1500 } })).toEqual([2]);
    expect(await ids(fx.TfIssue, { flag: true })).toEqual([2]);
    expect(await ids(fx.TfIssue, { label: "b" })).toEqual([2]);
    expect(await ids(fx.TfIssue, { price: "12.50" })).toEqual([2]);
    expect(await ids(fx.TfTicket, { issues: { $some: { n: { $gte: 5 } } } })).toEqual([1]);
    expect(await ids(fx.TfTicketStats, { rank: 20 })).toEqual([1]);
    expect(await ids(fx.TfTicketStats, { total: { $gte: 5 } })).toEqual([1]);
    expect(await ids(fx.TfTicketStats, { issueCount: 0 })).toEqual([2]);
  });
});
