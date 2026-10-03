import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { buildPrefixedWhere, buildWhere } from "../filter-builder";
import { RecordingDriver, prepareFixtures } from "./test-utils";

// Relational filter predicates ($some / $none), since 0.1.147: correlated
// [NOT] EXISTS subqueries executed for real on SQLite.

let sqliteVecAvailable = true;
try {
  new BetterSqlite3Driver(":memory:", { vector: true }).close();
} catch {
  sqliteVecAvailable = false;
}

/**
 * Works around a pre-existing DDL limitation: the SQL adapters render
 * `FOREIGN KEY (...)` from the LOGICAL FK field names, so a `@db.column`-renamed
 * FK column (`teamId` → `team_ref`, `ticketKey` → `ticket_ref`) fails
 * `CREATE TABLE`. Rewrites the two constraints to their physical columns —
 * the predicates under test correlate on physical names already.
 */
class RenamedFkDriver extends RecordingDriver {
  override exec(sql: string): void {
    let patched = sql.replace('FOREIGN KEY ("teamId")', 'FOREIGN KEY ("team_ref")');
    if (sql.includes('TABLE IF NOT EXISTS "rf_issues"') || sql.includes('TABLE "rf_issues"')) {
      patched = patched.replace('FOREIGN KEY ("ticketKey")', 'FOREIGN KEY ("ticket_ref")');
    }
    super.exec(patched);
  }
}

let fx: Record<string, any>;
let inner: BetterSqlite3Driver;
let driver: RecordingDriver;
let space: DbSpace;

const SF: [number, number] = [-122.42, 37.77];
const LA: [number, number] = [-118.24, 34.05];
const NYC: [number, number] = [-74.006, 40.71];

/** A 256-d vector with the given leading components (rest zero). */
function vec(...head: number[]): number[] {
  return [...head, ...Array.from<number>({ length: 256 - head.length }).fill(0)];
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rel-filter.as");
});

beforeEach(async () => {
  inner = new BetterSqlite3Driver(":memory:", { vector: sqliteVecAvailable });
  driver = new RenamedFkDriver(inner);
  space = new DbSpace(() => new SqliteAdapter(driver));
  for (const t of [
    fx.RfTeam,
    fx.RfTicket,
    fx.RfIssue,
    fx.RfLabel,
    fx.RfTicketLabel,
    fx.RfBoard,
    fx.RfCard,
  ]) {
    await space.getTable(t).ensureTable();
    await space.getTable(t).syncIndexes();
  }
  await t(fx.RfTeam).insertMany([
    { id: "t1", name: "Core" },
    { id: "t2", name: "Web" },
    { id: "t3", name: "Ops" },
  ]);
  const tickets = t(fx.RfTicket);
  await tickets.insertOne({
    key: "K1",
    title: "Login crash",
    teamId: "t1",
    status: "open",
    location: SF,
  });
  await tickets.insertOne({
    key: "K2",
    title: "Signup form",
    teamId: "t1",
    status: "closed",
    parentKey: "K1",
    location: LA,
  });
  await tickets.insertOne({
    key: "K3",
    title: "Dashboard slow",
    teamId: "t2",
    status: "open",
    parentKey: "K2",
    location: NYC,
  });
  await tickets.insertOne({ key: "K4", title: "Docs typo", status: "open" });
  await tickets.insertOne({
    key: "K5",
    title: "Deploy script",
    teamId: "t3",
    status: "closed",
    parentKey: "K1",
  });
  await t(fx.RfIssue).insertMany([
    { id: 1, title: "crash on submit", ticketKey: "K1" },
    { id: 2, title: "button misaligned", ticketKey: "K2" },
    { id: 3, title: "timeout", ticketKey: "K3" },
    { id: 4, title: "orphan" },
    { id: 5, title: "typo in intro", ticketKey: "K4" },
    { id: 6, title: "another orphan" },
  ]);
  await t(fx.RfLabel).insertMany([
    { id: 1, name: "bug" },
    { id: 2, name: "ui" },
    { id: 3, name: "hidden" },
  ]);
  await t(fx.RfTicketLabel).insertMany([
    { id: 1, ticketKey: "K1", labelId: 1, pinned: true },
    { id: 2, ticketKey: "K1", labelId: 2, pinned: false },
    { id: 3, ticketKey: "K2", labelId: 2, pinned: true },
    { id: 4, ticketKey: "K3", labelId: 3, pinned: true },
    { id: 5, ticketKey: "K5", labelId: 1, pinned: false },
  ]);
  await t(fx.RfBoard).insertMany([
    { org: "o1", code: "b1", title: "Alpha" },
    { org: "o1", code: "b2", title: "Beta" },
    { org: "o2", code: "b1", title: "Gamma" },
  ]);
  await t(fx.RfCard).insertMany([
    { id: 1, boardOrg: "o1", boardCode: "b1" },
    { id: 2, boardOrg: "o1", boardCode: "b2" },
    { id: 3, boardOrg: "o2", boardCode: "b1" },
    { id: 4, boardOrg: "o2" },
    { id: 5 },
  ]);
  driver.statements.length = 0;
});

afterEach(() => {
  inner.close();
});

function t(type: unknown): any {
  return space.getTable(type as never);
}

async function ids(type: unknown, filter: Record<string, unknown>, key = "id"): Promise<unknown[]> {
  const rows = await t(type).findMany({ filter, controls: { $sort: { [key]: 1 } } });
  return rows.map((r: Record<string, unknown>) => r[key]);
}

const keys = (filter: Record<string, unknown>) => ids(fx.RfTicket, filter, "key");

describe("[sqlite] relational predicates — reads", () => {
  it("advertises read and write support", () => {
    const adapter = t(fx.RfIssue).getAdapter() as SqliteAdapter;
    expect(adapter.supportsRelationFilters("read")).toBe(true);
    expect(adapter.supportsRelationFilters("write")).toBe(true);
  });

  it("to-one $some with $in + eq (renamed FK columns on both hops)", async () => {
    expect(
      await ids(fx.RfIssue, {
        ticket: { $some: { teamId: { $in: ["t1", "t2"] }, status: "open" } },
      }),
    ).toEqual([1, 3]);
    const sql = driver.statements.at(-1)!;
    expect(sql).toContain(
      'EXISTS (SELECT 1 FROM "rf_tickets" AS "_rf1" WHERE "_rf1"."key" = "rf_issues"."ticket_ref"',
    );
    expect(sql).toContain('"_rf1"."team_ref" IN (?, ?)');
  });

  it("$none includes rows with a NULL foreign key", async () => {
    expect(await ids(fx.RfIssue, { ticket: { $none: { status: "open" } } })).toEqual([2, 4, 6]);
  });

  it("$some: {} / $none: {} — has / has no related row", async () => {
    expect(await ids(fx.RfIssue, { ticket: { $some: {} } })).toEqual([1, 2, 3, 5]);
    expect(await ids(fx.RfIssue, { ticket: { $none: {} } })).toEqual([4, 6]);
  });

  it("from (to-many) $some / $none", async () => {
    expect(await keys({ issues: { $some: { title: { $regex: "crash" } } } })).toEqual(["K1"]);
    expect(await keys({ issues: { $none: {} } })).toEqual(["K5"]);
  });

  it("via $some / $none (target column renamed)", async () => {
    expect(await keys({ labels: { $some: { name: "bug" } } })).toEqual(["K1", "K5"]);
    expect(await keys({ labels: { $none: {} } })).toEqual(["K4"]);
  });

  it("composite foreign key, incl. NULL key parts", async () => {
    expect(await ids(fx.RfCard, { board: { $some: { title: "Beta" } } })).toEqual([2]);
    expect(await ids(fx.RfCard, { board: { $some: {} } })).toEqual([1, 2, 3]);
    expect(await ids(fx.RfCard, { board: { $none: {} } })).toEqual([4, 5]);
  });

  it("self relation (to and from) correlates to the outer row", async () => {
    expect(await keys({ parent: { $some: { status: "open" } } })).toEqual(["K2", "K5"]);
    expect(await keys({ parent: { $none: {} } })).toEqual(["K1", "K4"]);
    expect(await keys({ children: { $some: { status: "open" } } })).toEqual(["K2"]);
  });

  it("nested two hops", async () => {
    expect(
      await ids(fx.RfIssue, { ticket: { $some: { team: { $some: { name: "Core" } } } } }),
    ).toEqual([1, 2]);
    expect(
      await ids(fx.RfTeam, { openTickets: { $some: { labels: { $some: { name: "bug" } } } } }),
    ).toEqual(["t1"]);
    // three levels (the depth cap): ticket → parent → grand-parent
    expect(
      await ids(fx.RfIssue, {
        ticket: { $some: { parent: { $some: { parent: { $none: {} } } } } },
      }),
    ).toEqual([2]);
    expect(
      await ids(fx.RfIssue, {
        ticket: { $some: { parent: { $some: { parent: { $some: {} } } } } },
      }),
    ).toEqual([3]);
    expect(driver.statements.at(-1)).toContain('"_rf3"."key" = "_rf2"."parentKey"');
  });

  it("predicate inside $or and under $not", async () => {
    expect(
      await ids(fx.RfIssue, { $or: [{ id: 6 }, { ticket: { $some: { status: "closed" } } }] }),
    ).toEqual([2, 6]);
    expect(await ids(fx.RfIssue, { $not: { ticket: { $some: { status: "open" } } } })).toEqual([
      2, 4, 6,
    ]);
  });

  it("with $sort / $limit / $skip, count and findManyWithCount", async () => {
    const issues = t(fx.RfIssue);
    const filter = { ticket: { $some: {} } };
    const page = await issues.findMany({
      filter,
      controls: { $sort: { id: -1 }, $limit: 2, $skip: 1 },
    });
    expect(page.map((r: any) => r.id)).toEqual([3, 2]);
    expect(await issues.count({ filter })).toBe(4);
    const { data, count } = await issues.findManyWithCount({
      filter,
      controls: { $sort: { id: 1 }, $limit: 1 },
    });
    expect(count).toBe(4);
    expect(data.map((r: any) => r.id)).toEqual([1]);
  });

  it("$select excluding the foreign key still correlates", async () => {
    const rows = await t(fx.RfIssue).findMany({
      filter: { ticket: { $some: { status: "open" } } },
      controls: { $select: ["id", "title"], $sort: { id: 1 } },
    });
    expect(rows).toEqual([
      { id: 1, title: "crash on submit" },
      { id: 3, title: "timeout" },
      { id: 5, title: "typo in intro" },
    ]);
  });

  it("with $with of the same relation: filters parents and loads", async () => {
    const rows = await t(fx.RfIssue).findMany({
      filter: { ticket: { $some: { teamId: "t1" } } },
      controls: { $with: [{ name: "ticket" }], $sort: { id: 1 } },
    });
    expect(rows.map((r: any) => [r.id, r.ticket?.key])).toEqual([
      [1, "K1"],
      [2, "K2"],
    ]);
  });

  it("grouped aggregate + predicate", async () => {
    const rows = await t(fx.RfTicket).aggregate({
      filter: { issues: { $some: {} } },
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "count", $field: "*", $as: "n" }] as any,
        $sort: { status: 1 },
      },
    });
    expect(rows).toEqual([
      { status: "closed", n: 1 },
      { status: "open", n: 3 },
    ]);
  });
});

describe("[sqlite] @db.rel.filter in $with and predicates", () => {
  it("$with honors a from relation's @db.rel.filter", async () => {
    const rows = await t(fx.RfTeam).findMany({
      filter: {},
      controls: { $with: [{ name: "openTickets" }], $sort: { id: 1 } },
    });
    expect(rows.map((r: any) => [r.id, r.openTickets.map((x: any) => x.key)])).toEqual([
      ["t1", ["K1"]],
      ["t2", ["K3"]],
      ["t3", []],
    ]);
  });

  it("$with honors both junction and target parts of a via @db.rel.filter", async () => {
    const rows = await t(fx.RfTicket).findMany({
      filter: {},
      controls: { $with: [{ name: "pinnedLabels" }], $sort: { key: 1 } },
    });
    expect(rows.map((r: any) => [r.key, r.pinnedLabels.map((l: any) => l.name)])).toEqual([
      ["K1", ["bug"]],
      ["K2", ["ui"]],
      ["K3", []],
      ["K4", []],
      ["K5", []],
    ]);
  });

  it("predicates apply the relation's @db.rel.filter (target and junction parts)", async () => {
    expect(await ids(fx.RfTeam, { openTickets: { $some: {} } })).toEqual(["t1", "t2"]);
    expect(await ids(fx.RfTeam, { openTickets: { $none: {} } })).toEqual(["t3"]);
    expect(await keys({ pinnedLabels: { $some: {} } })).toEqual(["K1", "K2"]);
    expect(await keys({ pinnedLabels: { $some: { name: "ui" } } })).toEqual(["K2"]);
    const sql = driver.statements.at(-1)!;
    expect(sql).toContain('"_rf1"."pinned" = ?');
    expect(sql).toContain('"_rf2"."label_name" != ?');
  });
});

describe("[sqlite] relational predicates — writes", () => {
  it("updateMany / deleteMany with a predicate", async () => {
    const issues = t(fx.RfIssue);
    const upd = await issues.updateMany(
      { ticket: { $some: { status: "closed" } } },
      { title: "closed ticket" },
    );
    expect(upd.matchedCount).toBe(1);
    expect((await issues.findOne({ filter: { id: 2 }, controls: {} })).title).toBe("closed ticket");

    const cards = t(fx.RfCard);
    const del = await cards.deleteMany({ board: { $none: {} } });
    expect(del.deletedCount).toBe(2);
    expect(await ids(fx.RfCard, {})).toEqual([1, 2, 3]);
  });

  it("self-referencing predicate in updateMany", async () => {
    const tickets = t(fx.RfTicket);
    const res = await tickets.updateMany(
      { parent: { $some: { status: "open" } } },
      { status: "blocked" },
    );
    expect(res.matchedCount).toBe(2);
    expect(await keys({ status: "blocked" })).toEqual(["K2", "K5"]);
  });

  it("single-row update / delete (rowid subquery) correlate to the inner SELECT", async () => {
    const tickets = t(fx.RfTicket);
    const adapter = tickets.getAdapter() as SqliteAdapter;
    const q = tickets._translateForAdapter({ filter: { parent: { $some: { key: "K1" } } } });
    const upd = await adapter.updateOne(q.filter, { status: "x" });
    expect(upd.matchedCount).toBe(1);
    expect(await keys({ status: "x" })).toHaveLength(1);

    const issues = t(fx.RfIssue);
    const iq = issues._translateForAdapter({ filter: { ticket: { $none: {} } } });
    const del = await (issues.getAdapter() as SqliteAdapter).deleteOne(iq.filter);
    expect(del.deletedCount).toBe(1);
    expect(await ids(fx.RfIssue, { ticket: { $none: {} } })).toHaveLength(1);
  });
});

describe("[sqlite] relational predicates — aliased statements", () => {
  it("FTS search (table aliased `t`) + predicate", async () => {
    const tickets = t(fx.RfTicket);
    expect(
      (await tickets.search("crash", { filter: { issues: { $some: {} } }, controls: {} })).map(
        (r: any) => r.key,
      ),
    ).toEqual(["K1"]);
    expect(
      await tickets.search("login", { filter: { team: { $none: {} } }, controls: {} }),
    ).toEqual([]);
    const { data, count } = await tickets.searchWithCount("typo", {
      filter: { team: { $none: {} } },
      controls: {},
    });
    expect([data.map((r: any) => r.key), count]).toEqual([["K4"], 1]);
    expect(driver.statements.at(-1)).toContain('= t."team_ref"');
  });

  it("geo search (table aliased `t`) + predicate", async () => {
    const tickets = t(fx.RfTicket);
    if (!tickets.isGeoSearchable()) {
      return;
    }
    const rows = await tickets.geoSearch(SF, { filter: { parent: { $some: {} } }, controls: {} });
    expect(rows.map((r: any) => r.key)).toEqual(["K2", "K3"]);
    const { count } = await tickets.geoSearchWithCount(SF, {
      filter: { issues: { $some: { title: "timeout" } } },
      controls: {},
    });
    expect(count).toBe(1);
    expect(driver.statements.at(-1)).toContain('= "t"."key"');
  });

  it.skipIf(!sqliteVecAvailable)("vector search (residual on `_v`) + predicate", async () => {
    const notes = t(fx.RfNote);
    await notes.ensureTable();
    await notes.syncIndexes();
    await notes.insertMany([
      { id: "n1", ticketKey: "K1", embedding: vec(1) },
      { id: "n2", ticketKey: "K2", embedding: vec(0.9, 0.1) },
      { id: "n3", embedding: vec(0.8, 0.2) },
    ]);
    const rows = await notes.vectorSearch(vec(1), {
      filter: { ticket: { $some: { status: "closed" } } },
      controls: {},
    });
    expect(rows.map((r: any) => r.id)).toEqual(["n2"]);
    const { data, count } = await notes.vectorSearchWithCount(vec(1), {
      filter: { ticket: { $none: {} } },
      controls: {},
    });
    expect([data.map((r: any) => r.id), count]).toEqual([["n3"], 1]);
    expect(driver.statements.at(-1)).toContain('= _v."ticketKey"');
  });
});

describe("[sqlite] filter-builder wrappers", () => {
  it("buildPrefixedWhere prefixes own columns but not the subquery alias", async () => {
    const tickets = t(fx.RfTicket);
    const q = tickets._translateForAdapter({
      filter: { status: "open", issues: { $some: { title: "x" } } },
    });
    expect(buildPrefixedWhere("t", q.filter).sql).toBe(
      't."status" = ? AND EXISTS (SELECT 1 FROM "rf_issues" AS "_rf1" WHERE "_rf1"."ticket_ref" = t."key" AND "_rf1"."title" = ?)',
    );
    expect(buildWhere(q.filter).sql).toBe(
      '"status" = ? AND EXISTS (SELECT 1 FROM "rf_issues" AS "_rf1" WHERE "_rf1"."ticket_ref" = "rf_tickets"."key" AND "_rf1"."title" = ?)',
    );
  });
});
