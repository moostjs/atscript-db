import { DbError, ResolvedRelationFilter } from "@atscript/db";
import type { AtscriptDbTable, DbSpace, FilterExpr } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { MemoryAdapter, setMemoryProvider } from "../memory-adapter";
import { buildMemoryPredicate, prepareRelationSets } from "../memory-filter";
import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

// Relational filter predicates ($some / $none), since 0.1.147: the memory
// adapter evaluates the core's resolved predicates in reads and writes.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rel-filter.as");
});

const TEAMS = [
  { id: "A", name: "Core" },
  { id: "B", name: "Web" },
  { id: "C", name: "Ops" },
];

// T1 ← T2 ← T3 ← T5 parent chain; T4 has no team; T6 has no issues.
const TICKETS = [
  { key: "T1", teamId: "A", status: "open" },
  { key: "T2", teamId: "A", status: "closed", parentKey: "T1" },
  { key: "T3", teamId: "B", status: "open", parentKey: "T2" },
  { key: "T4", status: "open" },
  { key: "T5", teamId: "C", status: "closed", parentKey: "T3" },
  { key: "T6", teamId: "B", status: "closed" },
];

const ISSUES = [
  { id: 1, title: "crash", points: 3, ticketKey: "T1" },
  { id: 2, title: "typo", points: 1, ticketKey: "T2" },
  { id: 3, title: "slow", points: 5, ticketKey: "T3" },
  { id: 4, title: "orphan", points: 2 },
  { id: 5, title: "misc", points: 1, ticketKey: "T4" },
  { id: 6, title: "noise", points: 8, ticketKey: "T5" },
];

const LABELS = [
  { id: 1, name: "bug" },
  { id: 2, name: "ui" },
  { id: 3, name: "hidden" },
];

const TICKET_LABELS = [
  { id: 1, ticketKey: "T1", labelId: 1, pinned: true },
  { id: 2, ticketKey: "T1", labelId: 3, pinned: true },
  { id: 3, ticketKey: "T2", labelId: 2, pinned: false },
  { id: 4, ticketKey: "T3", labelId: 1, pinned: false },
  { id: 5, ticketKey: "T3", labelId: 2, pinned: true },
];

const BOARDS = [
  { org: "o1", code: "b1", title: "X" },
  { org: "o1", code: "b2", title: "Y" },
  { org: "o2", code: "b1", title: "Z" },
];

const CARDS = [
  { id: 1, boardOrg: "o1", boardCode: "b1" },
  { id: 2, boardOrg: "o1", boardCode: "b2" },
  { id: 3, boardOrg: "o2", boardCode: "b1" },
  { id: 4, boardOrg: "o1" },
  { id: 5 },
];

let space: DbSpace;
let teams: AtscriptDbTable;
let tickets: AtscriptDbTable;
let issues: AtscriptDbTable;
let cards: AtscriptDbTable;

beforeEach(async () => {
  space = createTestSpace();
  const types = [
    fx.RfTeam,
    fx.RfTicket,
    fx.RfIssue,
    fx.RfLabel,
    fx.RfTicketLabel,
    fx.RfBoard,
    fx.RfCard,
  ];
  await bootstrapStoredTables(space, types);
  teams = space.getTable(fx.RfTeam) as AtscriptDbTable;
  tickets = space.getTable(fx.RfTicket) as AtscriptDbTable;
  issues = space.getTable(fx.RfIssue) as AtscriptDbTable;
  cards = space.getTable(fx.RfCard) as AtscriptDbTable;
  await teams.insertMany(TEAMS as any);
  // one by one: the self FK (parentKey) must reference an existing ticket
  for (const ticket of TICKETS) await tickets.insertOne(ticket as any);
  await issues.insertMany(ISSUES as any);
  await space.getTable(fx.RfLabel).insertMany(LABELS as any);
  await space.getTable(fx.RfTicketLabel).insertMany(TICKET_LABELS as any);
  await space.getTable(fx.RfBoard).insertMany(BOARDS as any);
  await cards.insertMany(CARDS as any);
});

/** Primary keys of the rows `filter` matches, in key order. */
async function ids(table: AtscriptDbTable, filter: Record<string, unknown>): Promise<unknown[]> {
  const pk = table === tickets ? "key" : "id";
  const rows = (await table.findMany({
    filter,
    controls: { $sort: { [pk]: 1 } },
  } as any)) as Array<Record<string, unknown>>;
  return rows.map((r) => r[pk]);
}

/** The adapter-bound (translated, predicates resolved) form of a logical filter. */
function translated(table: AtscriptDbTable, filter: Record<string, unknown>): FilterExpr {
  return (table as any)._translateForAdapter({ filter }).filter as FilterExpr;
}

describe("MemoryAdapter relational predicates — capability", () => {
  it("supports predicates in reads and writes", () => {
    const adapter = new MemoryAdapter();
    expect(adapter.supportsRelationFilters("read")).toBe(true);
    expect(adapter.supportsRelationFilters("write")).toBe(true);
  });

  it("buildMemoryPredicate fails loud on an unprepared predicate", () => {
    const filter = translated(issues, { ticket: { $some: { status: "open" } } });
    let error: unknown;
    try {
      buildMemoryPredicate(filter)({ id: 1 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("REL_FILTER_NOT_SUPPORTED");
  });
});

describe("MemoryAdapter relational predicates — reads", () => {
  it("to-one $some with $in + eq (renamed FK columns on both sides)", async () => {
    expect(
      await ids(issues, {
        ticket: { $some: { teamId: { $in: ["A", "B"] }, status: "open" } },
      }),
    ).toEqual([1, 3]);
  });

  it("to-one $none includes rows with a NULL foreign key", async () => {
    expect(await ids(issues, { ticket: { $none: { status: "open" } } })).toEqual([2, 4, 6]);
  });

  it("$some: {} / $none: {} — has / has no related row", async () => {
    expect(await ids(issues, { ticket: { $some: {} } })).toEqual([1, 2, 3, 5, 6]);
    expect(await ids(issues, { ticket: { $none: {} } })).toEqual([4]);
  });

  it("$some and $none on one key are ANDed", async () => {
    expect(
      await ids(issues, { ticket: { $some: { teamId: "A" }, $none: { status: "closed" } } }),
    ).toEqual([1]);
  });

  it("from (to-many) $some / $none", async () => {
    expect(await ids(tickets, { issues: { $some: { title: { $regex: "crash|slow" } } } })).toEqual([
      "T1",
      "T3",
    ]);
    expect(await ids(tickets, { issues: { $none: {} } })).toEqual(["T6"]);
    expect(await ids(tickets, { issues: { $none: { points: { $gt: 2 } } } })).toEqual([
      "T2",
      "T4",
      "T6",
    ]);
  });

  it("via $some / $none (renamed target column in the inner filter)", async () => {
    expect(await ids(tickets, { labels: { $some: { name: "bug" } } })).toEqual(["T1", "T3"]);
    expect(await ids(tickets, { labels: { $none: {} } })).toEqual(["T4", "T5", "T6"]);
  });

  it("via with @db.rel.filter: junction and target parts both apply", async () => {
    // pinned junction rows only, label "hidden" excluded
    expect(await ids(tickets, { pinnedLabels: { $some: {} } })).toEqual(["T1", "T3"]);
    expect(await ids(tickets, { pinnedLabels: { $some: { name: "ui" } } })).toEqual(["T3"]);
    expect(await ids(tickets, { pinnedLabels: { $some: { name: "hidden" } } })).toEqual([]);
    expect(await ids(tickets, { pinnedLabels: { $none: {} } })).toEqual(["T2", "T4", "T5", "T6"]);
  });

  it("from with @db.rel.filter: the target condition is part of the relation", async () => {
    expect(await ids(teams, { openTickets: { $some: {} } })).toEqual(["A", "B"]);
    expect(await ids(teams, { openTickets: { $none: {} } })).toEqual(["C"]);
  });

  it("composite foreign key; a partially NULL key has no related row", async () => {
    expect(await ids(cards, { board: { $some: { title: "X" } } })).toEqual([1]);
    expect(await ids(cards, { board: { $some: {} } })).toEqual([1, 2, 3]);
    expect(await ids(cards, { board: { $none: {} } })).toEqual([4, 5]);
  });

  it("self relation", async () => {
    expect(await ids(tickets, { parent: { $some: { status: "open" } } })).toEqual(["T2", "T5"]);
    expect(await ids(tickets, { parent: { $none: {} } })).toEqual(["T1", "T4", "T6"]);
  });

  it("nested predicates: two and three hops", async () => {
    expect(await ids(issues, { ticket: { $some: { team: { $some: { name: "Core" } } } } })).toEqual(
      [1, 2],
    );
    expect(
      await ids(issues, {
        ticket: { $some: { parent: { $some: { team: { $some: { name: "Core" } } } } } },
      }),
    ).toEqual([2, 3]);
    expect(
      await ids(teams, { openTickets: { $some: { labels: { $some: { name: "ui" } } } } }),
    ).toEqual(["B"]);
  });

  it("predicates under $or and $not", async () => {
    expect(
      await ids(issues, {
        $or: [{ title: "orphan" }, { ticket: { $some: { status: "closed" } } }],
      }),
    ).toEqual([2, 4, 6]);
    expect(await ids(issues, { $not: { ticket: { $some: { status: "open" } } } })).toEqual([
      2, 4, 6,
    ]);
    expect(
      await ids(issues, {
        $and: [{ points: { $gte: 2 } }, { $not: { ticket: { $none: {} } } }],
      }),
    ).toEqual([1, 3, 6]);
  });

  it("with sort / skip / limit / count / findManyWithCount / findOne", async () => {
    const filter = { ticket: { $some: {} } };
    const page = (await issues.findMany({
      filter,
      controls: { $sort: { id: -1 }, $skip: 1, $limit: 2 },
    } as any)) as any[];
    expect(page.map((r) => r.id)).toEqual([5, 3]);
    expect(await issues.count({ filter } as any)).toBe(5);
    const withCount = await issues.findManyWithCount({
      filter,
      controls: { $sort: { points: -1 }, $limit: 1 },
    } as any);
    expect(withCount.count).toBe(5);
    expect(withCount.data.map((r: any) => r.id)).toEqual([6]);
    const one = (await issues.findOne({
      filter: { ticket: { $some: { teamId: "B" } } },
    } as any)) as any;
    expect(one.id).toBe(3);
  });

  it("grouped aggregate with a predicate", async () => {
    const rows = await issues.aggregate({
      filter: { ticket: { $some: { teamId: "A" } } },
      controls: {
        $groupBy: ["ticketKey"],
        $select: ["ticketKey", { $fn: "sum", $field: "points" }],
        $sort: { ticketKey: 1 },
      },
    } as any);
    expect(rows).toEqual([
      { ticketKey: "T1", sum_points: 3 },
      { ticketKey: "T2", sum_points: 1 },
    ]);
  });

  it("$select excluding the FK still correlates", async () => {
    const rows = (await issues.findMany({
      filter: { ticket: { $some: { status: "open" } } },
      controls: { $select: ["title"], $sort: { id: 1 } },
    } as any)) as any[];
    expect(rows).toEqual([{ title: "crash" }, { title: "slow" }, { title: "misc" }]);
  });

  it("combined with $with of the same relation: filters parents and loads", async () => {
    const rows = (await issues.findMany({
      filter: { ticket: { $some: { status: "closed" } } },
      controls: { $with: [{ name: "ticket" }], $sort: { id: 1 } },
    } as any)) as any[];
    expect(rows.map((r) => [r.id, r.ticket?.key])).toEqual([
      [2, "T2"],
      [6, "T5"],
    ]);
  });

  it("renamed FK column correlates by its physical name", async () => {
    const adapter = space.getAdapter(fx.RfIssue) as MemoryAdapter;
    const stored = (await adapter.findMany({ filter: { id: 1 }, controls: {} })) as any[];
    expect(stored[0]).toHaveProperty("ticket_ref", "T1");
    const filter = translated(issues, { ticket: { $some: { teamId: "A" } } });
    const rows = await adapter.findMany({ filter, controls: { $sort: { id: 1 } } });
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it("predicate-free filters are unchanged", async () => {
    expect(await ids(issues, { points: { $gt: 2 } })).toEqual([1, 3, 6]);
  });
});

describe("MemoryAdapter — @db.rel.filter honored by $with loading (regression)", () => {
  it("from: loads only the related rows the filter keeps", async () => {
    const rows = (await teams.findMany({
      filter: {},
      controls: { $with: [{ name: "openTickets" }], $sort: { id: 1 } },
    } as any)) as any[];
    expect(rows.map((r) => [r.id, r.openTickets.map((t: any) => t.key)])).toEqual([
      ["A", ["T1"]],
      ["B", ["T3"]],
      ["C", []],
    ]);
  });

  it("via: junction and target parts both apply", async () => {
    const rows = (await tickets.findMany({
      filter: { key: { $in: ["T1", "T2", "T3"] } },
      controls: { $with: [{ name: "pinnedLabels" }], $sort: { key: 1 } },
    } as any)) as any[];
    expect(rows.map((r) => [r.key, r.pinnedLabels.map((l: any) => l.name)])).toEqual([
      ["T1", ["bug"]],
      ["T2", []],
      ["T3", ["ui"]],
    ]);
  });
});

describe("MemoryAdapter relational predicates — writes", () => {
  it("updateMany changes only the matching rows", async () => {
    const result = await (issues as any).updateMany(
      { ticket: { $some: { status: "open" } } },
      { points: 0 },
    );
    expect(result.matchedCount).toBe(3);
    const rows = (await issues.findMany({
      filter: {},
      controls: { $sort: { id: 1 } },
    } as any)) as any[];
    expect(rows.map((r) => r.points)).toEqual([0, 1, 0, 2, 0, 8]);
  });

  it("deleteMany removes only the matching rows (NULL FK ⇒ $none)", async () => {
    const result = await (issues as any).deleteMany({ ticket: { $none: {} } });
    expect(result.deletedCount).toBe(1);
    expect(await ids(issues, {})).toEqual([1, 2, 3, 5, 6]);
  });

  it("deleteMany on a self relation evaluates against the pre-mutation rows", async () => {
    // T2 and T5 have an open parent; deleting them must not change the outcome mid-way.
    const result = await (tickets as any).deleteMany({ parent: { $some: { status: "open" } } });
    expect(result.deletedCount).toBe(2);
    expect(await ids(tickets, {})).toEqual(["T1", "T3", "T4", "T6"]);
  });

  it("updateOne / replaceOne / deleteOne (adapter level) honor predicates", async () => {
    const adapter = space.getAdapter(fx.RfIssue) as MemoryAdapter;
    const closed = translated(issues, { ticket: { $some: { status: "closed" } } });
    expect(await adapter.updateOne(closed, { title: "first-closed" })).toEqual({
      matchedCount: 1,
      modifiedCount: 1,
    });
    const viaTeam = translated(issues, {
      id: 5,
      ticket: { $some: { team: { $some: { name: "Core" } } } },
    });
    // issue 5's ticket has no team → no match
    expect(await adapter.updateOne(viaTeam, { title: "x" })).toEqual({
      matchedCount: 0,
      modifiedCount: 0,
    });
    const orphan = translated(issues, { ticket: { $none: {} } });
    expect(await adapter.replaceOne(orphan, { id: 4, title: "replaced", points: 9 })).toEqual({
      matchedCount: 1,
      modifiedCount: 1,
    });
    expect(
      await adapter.deleteOne(translated(issues, { ticket: { $some: { key: "T5" } } })),
    ).toEqual({ deletedCount: 1 });
    const rows = (await issues.findMany({
      filter: {},
      controls: { $sort: { id: 1 } },
    } as any)) as any[];
    expect(rows.map((r) => [r.id, r.title])).toEqual([
      [1, "crash"],
      [2, "first-closed"],
      [3, "slow"],
      [4, "replaced"],
      [5, "misc"],
    ]);
  });

  it("replaceMany honors predicates", async () => {
    const adapter = space.getAdapter(fx.RfIssue) as MemoryAdapter;
    const filter = translated(issues, { ticket: { $some: { teamId: "A" } } });
    expect(await adapter.replaceMany(filter, { points: 7 })).toEqual({
      matchedCount: 2,
      modifiedCount: 2,
    });
    expect(await ids(issues, { points: 7 })).toEqual([1, 2]);
  });
});

describe("MemoryAdapter relational predicates — provider (read-through) targets", () => {
  it("loads a provider-backed related table once per read", async () => {
    let calls = 0;
    setMemoryProvider(space, fx.RfTicket, () => {
      calls++;
      // provider rows are PHYSICAL (`teamId` is stored as `team_ref`)
      return TICKETS.map((t) => {
        const row: Record<string, unknown> = { key: t.key, status: t.status };
        if (t.teamId !== undefined) row.team_ref = t.teamId;
        if (t.parentKey !== undefined) row.parentKey = t.parentKey;
        return row;
      });
    });
    expect(await ids(issues, { ticket: { $some: { status: "open" } } })).toEqual([1, 3, 5]);
    expect(calls).toBe(1);

    calls = 0;
    expect(await issues.count({ filter: { ticket: { $none: { status: "open" } } } } as any)).toBe(
      3,
    );
    expect(calls).toBe(1);

    // two predicates on the same related table share one snapshot
    calls = 0;
    await ids(issues, {
      $or: [{ ticket: { $some: { teamId: "A" } } }, { ticket: { $none: {} } }],
    });
    expect(calls).toBe(1);

    // self relation on the provider table: the outer scan's snapshot is reused
    calls = 0;
    expect(await ids(tickets, { parent: { $some: { status: "open" } } })).toEqual(["T2", "T5"]);
    expect(calls).toBe(1);
  });
});

describe("MemoryAdapter relational predicates — failure paths", () => {
  it("a rejecting own snapshot while related tables load is not an unhandled rejection", async () => {
    // issues (the scanned table) reject fast; tickets (related) resolve slowly
    setMemoryProvider(
      space,
      fx.RfIssue,
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("store down")), 5)),
    );
    setMemoryProvider(
      space,
      fx.RfTicket,
      () =>
        new Promise((resolve) => setTimeout(() => resolve([{ key: "T1", status: "open" }]), 40)),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        issues.findMany({ filter: { ticket: { $some: { status: "open" } } }, controls: {} } as any),
      ).rejects.toThrow("store down");
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe("memory correlation keys are type-tagged", () => {
  // A hand-built resolved predicate over a fake loader: source column `k`
  // correlates with target column `id`.
  const target = { tag: "target" } as any;
  const node = new ResolvedRelationFilter({
    kind: "to",
    nav: "t",
    source: { table: "s", name: "s", adapter: {} as any },
    target: { table: "x", name: "x", adapter: target },
    pairs: [{ source: "k", target: "id" }],
    filter: {},
  });
  const matches = async (targetIds: unknown[], sourceKey: unknown) => {
    const filter = { t: { $some: node } } as unknown as FilterExpr;
    const sets = await prepareRelationSets(filter, async () => targetIds.map((id) => ({ id })));
    return buildMemoryPredicate(filter, sets)({ k: sourceKey });
  };

  it("does not equate values of different types that used to share a key", async () => {
    expect(await matches(["5n"], 5n)).toBe(false);
    expect(await matches([5n], "5n")).toBe(false);
    const d = new Date("2026-01-02T03:04:05.000Z");
    expect(await matches([d.toISOString()], d)).toBe(false);
    expect(await matches([d], d.toISOString())).toBe(false);
    expect(await matches(["1"], 1)).toBe(false);
    expect(await matches(["true"], true)).toBe(false);
  });

  it("still equates equal values of the same type (Dates by instant)", async () => {
    expect(await matches([5n], 5n)).toBe(true);
    expect(await matches(["a"], "a")).toBe(true);
    expect(await matches([1], 1)).toBe(true);
    expect(await matches([0], -0)).toBe(true);
    const d = new Date("2026-01-02T03:04:05.000Z");
    expect(await matches([new Date(d.getTime())], d)).toBe(true);
    expect(await matches([null], null)).toBe(false);
    expect(await matches([Number.NaN], Number.NaN)).toBe(false);
  });
});
