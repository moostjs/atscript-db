/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll } from "vite-plus/test";
import {
  DbError,
  DbSpace,
  isResolvedRelationFilter,
  REL_FILTER_MAX_DEPTH,
  REL_FILTER_MAX_NODES,
  type DbQuery,
  type FilterExpr,
  type ResolvedRelationFilter,
} from "@atscript/db";
import { HttpError, Post } from "@moostjs/event-http";
import { getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { AsDbReadableController } from "../as-db-readable.controller";
import type { TDbRequestContext } from "../as-readable.controller";
import { TableController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { REL_FILTER_CLIENT_MAX_DEPTH, REL_FILTER_CLIENT_MAX_NODES } from "../index";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import {
  bootHttp,
  createMockApp as makeApp,
  errorsOf,
  httpReplyFor,
  prepareFixtures,
} from "./test-utils";

/**
 * Client relational predicates over HTTP (since 0.1.147): `nav=$some(…)` /
 * `nav=$none(…)` pass only on `@db.rel.filterable` relations the request
 * may see, with the related table's own capability rules on every operand
 * path, the depth / count caps over the whole request (`$with` sub-filters
 * included), and the `transformRelationFilter` row overlay applied before
 * `transformFilter`. Server-side filters (`actionRowScope`) use predicates
 * freely.
 *
 * Runs on a MockAdapter subclass that evaluates resolved predicates in
 * memory (independent of the db-memory adapter build).
 */

// ── An adapter that evaluates resolved predicates ───────────────────────────

class RelEvalAdapter extends MockAdapter {
  override supportsRelationFilters(): boolean {
    return true;
  }
  rowsOf(): Array<Record<string, unknown>> {
    return this._rows();
  }
  override async findMany(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    this.record("findMany", query);
    return this._rows().filter((row) => matches(row, query.filter ?? {}));
  }
  override async findOne(query: DbQuery): Promise<Record<string, unknown> | null> {
    this.record("findOne", query);
    return this._rows().find((row) => matches(row, query.filter ?? {})) ?? null;
  }
  override async count(query: DbQuery): Promise<number> {
    this.record("count", query);
    return this._rows().filter((row) => matches(row, query.filter ?? {})).length;
  }
}

function relatedRows(
  row: Record<string, unknown>,
  node: ResolvedRelationFilter,
): Array<Record<string, unknown>> {
  const targets = (node.target.adapter as RelEvalAdapter).rowsOf();
  return targets.filter((t) =>
    node.pairs.every((p) => row[p.source] != null && t[p.target] === row[p.source]),
  );
}

function matches(row: Record<string, unknown>, filter: FilterExpr): boolean {
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === "$and" && !(value as FilterExpr[]).every((f) => matches(row, f))) return false;
    if (key === "$or" && !(value as FilterExpr[]).some((f) => matches(row, f))) return false;
    if (key === "$not" && matches(row, value as FilterExpr)) return false;
    if (key.startsWith("$")) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [op, arg] of Object.entries(value)) {
        if (!matchesOp(row, key, op, arg)) return false;
      }
    } else if (!same(row[key], value)) {
      return false;
    }
  }
  return true;
}

const scalar = (v: unknown) => typeof v === "string" || typeof v === "number";

/** Equality with the id coercion real adapters apply (`/one/1` → id `"1"`). */
function same(a: unknown, b: unknown): boolean {
  if ((a ?? null) === (b ?? null)) return true;
  return scalar(a) && scalar(b) && String(a) === String(b);
}

function matchesOp(row: Record<string, unknown>, key: string, op: string, arg: any): boolean {
  switch (op) {
    case "$some":
    case "$none": {
      expect(isResolvedRelationFilter(arg)).toBe(true);
      const found = relatedRows(row, arg).some((t) => matches(t, arg.filter));
      return op === "$some" ? found : !found;
    }
    case "$eq":
      return row[key] === arg;
    case "$ne":
      return row[key] !== arg;
    case "$in":
      return (arg as unknown[]).includes(row[key]);
    case "$nin":
      return !(arg as unknown[]).includes(row[key]);
    default:
      throw new Error(`RelEvalAdapter: unsupported operator ${op}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

let RpTeam: any;
let RpTicket: any;
let RpIssue: any;
let RpBoard: any;

const TEAMS = [
  { id: "t1", name: "Core" },
  { id: "t2", name: "Edge" },
];
const TICKETS = [
  { key: "k1", teamId: "t1", status: "open" },
  { key: "k2", teamId: "t1", status: "closed" },
  { key: "k3", teamId: "t2", status: "open" },
  { key: "k4", teamId: null, status: "open" },
];
const ISSUES = [
  { id: 1, title: "a", ticketKey: "k1", otherKey: "k1", boardId: "b1" },
  { id: 2, title: "b", ticketKey: "k2", otherKey: "k2", boardId: null },
  { id: 3, title: "c", ticketKey: "k3", otherKey: "k3", boardId: null },
  { id: 4, title: "d", ticketKey: null, otherKey: null, boardId: null },
];
const BOARDS = [{ id: "b1", title: "x", owner: "u1" }];

const encryption = { defaultKeyId: "k1", keys: { k1: randomBytes(32) } };

function space() {
  const db = new DbSpace(() => new RelEvalAdapter(), { encryption });
  const seed = (type: any, rows: Array<Record<string, unknown>>) => {
    const table = db.getTable(type);
    (table.getAdapter() as unknown as RelEvalAdapter).store.set(
      table.tableName,
      rows.map((row) => ({ ...row })),
    );
    return table;
  };
  return {
    teams: seed(RpTeam, TEAMS),
    tickets: seed(RpTicket, TICKETS),
    issues: seed(RpIssue, ISSUES),
    boards: seed(RpBoard, BOARDS),
  };
}

type TCtrl = new (...args: any[]) => AsDbReadableController<any>;

/** A controller of `Ctrl` over the issues table (or `which`). */
function bind(
  Ctrl: TCtrl = AsDbReadableController,
  which: "issues" | "teams" | "tickets" = "issues",
) {
  const tables = space();
  const table = tables[which];
  const controller = new Ctrl(makeApp(), table as any) as any;
  return { controller, table, tables, adapter: table.getAdapter() as unknown as RelEvalAdapter };
}

/** Controllers hiding every path at or under the listed heads. */
function hiding(paths: string[], Base: TCtrl = AsDbReadableController): TCtrl {
  class Hiding extends (Base as typeof AsDbReadableController) {
    protected override hasField(path: string): boolean {
      return !paths.some((p) => path === p || path.startsWith(`${p}.`)) && super.hasField(path);
    }
  }
  return Hiding;
}

const ids = (rows: unknown) => (rows as Array<{ id: unknown }>).map((r) => r.id);

async function rejected(res: unknown): Promise<{ message: string; path?: string }> {
  const err = await res;
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).body.statusCode).toBe(400);
  return errorsOf(err)?.[0] ?? { message: (err as HttpError).body.message as string };
}

beforeAll(async () => {
  await prepareFixtures();
  ({ RpTeam, RpTicket, RpIssue, RpBoard } = await import("./fixtures/rel-predicates.as"));
});

/** `n` OR-ed top-level predicates on a team's tickets. */
const manyPredicates = (n: number) =>
  Array.from({ length: n }, (_, i) => `tickets=$some(status=s${i})`).join("^");

// ── Execution ───────────────────────────────────────────────────────────────

describe("client predicates run on opted-in relations", () => {
  it("to-one $some / $none, nested two hops, from (to-many)", async () => {
    const { controller } = bind();
    expect(ids(await controller.query("?ticket=$some(status=open)"))).toEqual([1, 3]);
    // A NULL foreign key has no related row: $none holds.
    expect(ids(await controller.query("?ticket=$none(status=open)"))).toEqual([2, 4]);
    expect(ids(await controller.query("?ticket=$some()"))).toEqual([1, 2, 3]);
    expect(ids(await controller.query("?ticket=$some(team=$some(name=Core))"))).toEqual([1, 2]);
    const teams = bind(AsDbReadableController, "teams").controller;
    expect(ids(await teams.query("?tickets=$some(issues=$some(title=c))"))).toEqual(["t2"]);
  });

  it("/pages, $count and the manual-mode related table's filterable field", async () => {
    const { controller } = bind();
    const page = await controller.pages("?ticket=$some(status=open)&$page=1&$size=10");
    expect(page.count).toBe(2);
    expect(ids(page.data)).toEqual([1, 3]);
    expect(await controller.query("?ticket=$some(status=open)&$count=true")).toBe(2);
    expect(ids(await controller.query("?board=$some(title=x)"))).toEqual([1]);
  });

  it("a grouped query passes the predicate to the adapter's aggregate", async () => {
    const { controller, adapter } = bind();
    await controller.query("?ticket=$some(status=open)&$groupBy=title&$select=title,count(*):n");
    const call = adapter.calls.findLast((c) => c.method === "aggregate")!;
    const filter = call.args[0].filter as Record<string, any>;
    expect(isResolvedRelationFilter(filter.ticket.$some)).toBe(true);
  });
});

// ── The gate ────────────────────────────────────────────────────────────────

describe("the gate", () => {
  it("a relation without @db.rel.filterable is rejected — the adapter is never reached", async () => {
    const { controller, adapter } = bind();
    expect(await rejected(controller.query("?ticketPlain=$some(status=open)"))).toEqual({
      path: "ticketPlain",
      message:
        'Filtering by related "ticketPlain" rows is not permitted — add @db.rel.filterable to enable.',
    });
    expect(adapter.calls.some((c) => c.method === "findMany")).toBe(false);
  });

  it("a hidden relation answers exactly like a nonexistent one", async () => {
    const { controller } = bind(hiding(["ticket"]));
    const hidden = await rejected(controller.query("?ticket=$some(status=open)"));
    const missing = await rejected(controller.query("?nope=$some(status=open)"));
    expect(hidden).toEqual({ message: 'Unknown field "ticket"' });
    expect(missing).toEqual({ message: 'Unknown field "nope"' });
    // Nested: the hidden hop is named, not its operand path.
    const nested = bind(hiding(["ticket.team"])).controller;
    expect(await rejected(nested.query("?ticket=$some(team=$some(name=Core))"))).toEqual({
      message: 'Unknown field "ticket.team"',
    });
  });

  it("the gate itself (no URL insights) rejects hidden relations and hidden operand paths", () => {
    const { controller } = bind(hiding(["ticket.status", "board"]));
    const gate = (filter: FilterExpr) => controller.checkCapabilities({ filter, controls: {} });
    expect(errorsOf(gate({ board: { $some: {} } }))).toEqual([
      { path: "board", message: 'Unknown field "board"' },
    ]);
    expect(errorsOf(gate({ ticket: { $some: { status: "open" } } }))).toEqual([
      { path: "ticket.status", message: 'Unknown field "ticket.status"' },
    ]);
    expect(gate({ ticket: { $some: { key: "k1" } } })).toBeUndefined();
  });

  it("a hidden operand path is an unknown field", async () => {
    const { controller } = bind(hiding(["ticket.status"]));
    expect(await rejected(controller.query("?ticket=$some(status=open)"))).toEqual({
      message: 'Unknown field "ticket.status"',
    });
  });

  it("the related table's capability rules apply to every operand path", async () => {
    const { controller } = bind();
    expect(await rejected(controller.query("?ticket=$some(note=x)"))).toEqual({
      path: "ticket.note",
      message: expect.stringMatching(
        /^Filtering on field "ticket\.note" is not permitted — .*encrypt/,
      ),
    });
    expect(await rejected(controller.query("?ticket=$some(code=x)"))).toEqual({
      path: "ticket.code",
      message: 'Filtering on field "ticket.code" is not permitted — field is @db.writeOnly.',
    });
    expect(await rejected(controller.query("?board=$some(owner=u1)"))).toEqual({
      path: "board.owner",
      message:
        'Filtering on field "board.owner" is not permitted — add @db.column.filterable to enable.',
    });
    const json = await rejected(controller.query("?ticket=$some(payload.region=eu)"));
    expect(json.path).toBe("ticket.payload.region");
    expect(json.message).toContain('inside JSON-stored column "ticket.payload"');
  });

  it("a derived field whose source is hidden is an unknown field", async () => {
    const { controller } = bind(hiding(["ticket.payload"]));
    expect(await rejected(controller.query("?ticket=$some(region=eu)"))).toEqual({
      path: "ticket.region",
      message: 'Unknown field "ticket.region"',
    });
    expect(ids(await bind().controller.query("?ticket=$some(region=eu)"))).toEqual([]);
  });

  it("dotted navigation paths name the predicate", async () => {
    const { controller } = bind();
    const dotted = await rejected(controller.query("?ticket.status=open"));
    expect(dotted.path).toBe("ticket.status");
    expect(dotted.message).toContain(
      "use ticket=$some(status=…) to filter by related rows (requires @db.rel.filterable), or $with=ticket(...)",
    );
    const nav = await rejected(controller.query("?ticket=k1"));
    expect(nav.message).toBe(
      '"ticket" is a navigation property — use ticket=$some(…) to filter by related rows ' +
        "(requires @db.rel.filterable), or $with=ticket to load it",
    );
    // `$select` keeps the `$with` hint alone.
    expect((await rejected(controller.query("?$select=ticket.status"))).message).not.toContain(
      "$some",
    );
    // Inside an operand, a dotted navigation path is answered relative to it.
    const inner = await rejected(controller.query("?ticket=$some(team.name=Core)"));
    expect(inner).toEqual({
      path: "ticket.team.name",
      message:
        '"ticket.team.name" is a navigation path — use team=$some(name=…) to filter by related rows ' +
        "(requires @db.rel.filterable)",
    });
  });

  it("$some / $none on a field that is not a relation", async () => {
    const { controller } = bind();
    expect(await rejected(controller.query("?title=$some(x=1)"))).toEqual({
      path: "title",
      message: '"$some" / "$none" are only valid on a navigation relation — "title" is not one',
    });
  });

  it("the client caps leave the core caps headroom for server overlays", () => {
    expect(REL_FILTER_MAX_DEPTH).toBeGreaterThan(REL_FILTER_CLIENT_MAX_DEPTH);
    expect(REL_FILTER_MAX_NODES).toBeGreaterThan(REL_FILTER_CLIENT_MAX_NODES);
  });

  it("nesting is capped at REL_FILTER_CLIENT_MAX_DEPTH (3) per chain", async () => {
    const { controller } = bind();
    expect(
      ids(await controller.query("?ticket=$some(team=$some(tickets=$some(status=open)))")),
    ).toEqual([1, 2, 3]);
    expect(
      await rejected(
        controller.query("?ticket=$some(team=$some(tickets=$some(issues=$some(title=a))))"),
      ),
    ).toEqual({
      path: "ticket.team.tickets.issues",
      message: 'Relational predicates nest at most 3 levels deep ("ticket.team.tickets.issues")',
    });
  });

  it("a chain may cross the same relation twice (default hasField); the cap still names the depth", async () => {
    const { controller } = bind();
    expect(
      ids(await controller.query("?ticket=$some(issues=$some(ticket=$some(status=open)))")),
    ).toEqual([1, 3]);
    expect(
      await rejected(controller.query("?ticket=$some(issues=$some(ticket=$some(issues=$some())))")),
    ).toEqual({
      path: "ticket.issues.ticket.issues",
      message: 'Relational predicates nest at most 3 levels deep ("ticket.issues.ticket.issues")',
    });
    const rows = (await controller.query(
      "?$with=ticket($with=issues($with=ticket($select=status)))&$sort=id",
    )) as Array<{ id: number; ticket?: { issues: Array<{ ticket?: { status: string } }> } }>;
    expect(rows).toBeInstanceOf(Array);
    expect(rows[0].ticket?.issues[0].ticket?.status).toBe("open");
  });

  it("at most REL_FILTER_CLIENT_MAX_NODES (8) predicates per request, $with sub-filters included", async () => {
    const { controller } = bind(AsDbReadableController, "teams");
    expect(await controller.query(`?${manyPredicates(8)}`)).toEqual([]);
    expect(await rejected(controller.query(`?${manyPredicates(9)}`))).toEqual({
      path: "tickets",
      message: "At most 8 relational predicates per query",
    });
    const sub = "$with=tickets(issues=$some(title=a)^issues=$some(title=b))";
    expect(Array.isArray(await controller.query(`?${manyPredicates(6)}&${sub}`))).toBe(true);
    expect(await rejected(controller.query(`?${manyPredicates(7)}&${sub}`))).toEqual({
      path: "tickets.issues",
      message: "At most 8 relational predicates per query",
    });
  });

  it("never in $having", async () => {
    const { controller } = bind();
    const res = await controller.query(
      "?$groupBy=title&$select=title,count(*):n&$having=ticket=$some(status=open)",
    );
    expect(res).toBeInstanceOf(HttpError);
    expect((res as HttpError).body.statusCode).toBe(400);
  });

  it("REL_FILTER_NOT_SUPPORTED maps to 400", () => {
    const reply = httpReplyFor(
      new DbError("REL_FILTER_NOT_SUPPORTED", [{ path: "ticket", message: "no" }]),
    );
    expect(reply.body.statusCode).toBe(400);
  });
});

// ── $with sub-filters ───────────────────────────────────────────────────────

describe("predicates inside $with sub-filters", () => {
  it("are allowed on opted-in relations, at the entry's path", async () => {
    const { controller } = bind(AsDbReadableController, "teams");
    const rows = await controller.query("?$with=tickets(issues=$some(title=c))");
    const byTeam = Object.fromEntries(
      (rows as Array<{ id: string; tickets: Array<{ key: string }> }>).map((t) => [
        t.id,
        t.tickets.map((k) => k.key),
      ]),
    );
    expect(byTeam).toEqual({ t1: [], t2: ["k3"] });
  });

  it("are rejected on relations that did not opt in, and on hidden ones", async () => {
    const { controller } = bind(AsDbReadableController, "teams");
    expect(await rejected(controller.query("?$with=tickets(plainIssues=$some(title=c))"))).toEqual({
      path: "tickets.plainIssues",
      message:
        'Filtering by related "tickets.plainIssues" rows is not permitted — add @db.rel.filterable to enable.',
    });
    const hidden = bind(hiding(["tickets.issues"]), "teams").controller;
    expect(await rejected(hidden.query("?$with=tickets(issues=$some(title=c))"))).toEqual({
      message: 'Unknown field "tickets.issues"',
    });
    expect(
      await rejected(controller.query("?$with=tickets(issues=$some(ticket=$some(note=x)))")),
    ).toMatchObject({ path: "tickets.issues.ticket.note" });
  });
});

// ── transformRelationFilter ─────────────────────────────────────────────────

describe("transformRelationFilter", () => {
  /** A controller recording the hook / transformFilter calls; `ticket` is narrowed to team t1. */
  function overlaid(Base: TCtrl = AsDbReadableController) {
    const log: string[] = [];
    const contexts: TDbRequestContext[] = [];
    class Overlaid extends (Base as typeof AsDbReadableController) {
      protected async prepareRequest(ctx: TDbRequestContext): Promise<void> {
        contexts.push(ctx);
      }
      protected override transformRelationFilter(path: string, filter: FilterExpr) {
        log.push(`rel:${path}`);
        return path === "ticket"
          ? ({ $and: [{ teamId: "t1" }, filter] } as FilterExpr)
          : path === "ticket.team"
            ? ({ $and: [{ name: { $ne: "Core" } }, filter] } as FilterExpr)
            : filter;
      }
      protected override transformFilter(filter: FilterExpr) {
        log.push("transformFilter");
        return filter;
      }
    }
    return { Overlaid: Overlaid as TCtrl, log, contexts };
  }

  it("runs before transformFilter and restricts what $some matches / $none excludes", async () => {
    const { Overlaid, log } = overlaid();
    const { controller } = bind(Overlaid);
    expect(ids(await controller.query("?ticket=$some(status=open)"))).toEqual([1]);
    expect(log).toEqual(["rel:ticket", "transformFilter"]);
    // k3 (team t2) is not visible: it no longer blocks $none.
    expect(ids(await controller.query("?ticket=$none(status=open)"))).toEqual([2, 3, 4]);
  });

  it("full paths for nested predicates — the inner operand first, the hook output not re-walked", async () => {
    const { Overlaid, log } = overlaid();
    const { controller } = bind(Overlaid);
    expect(ids(await controller.query("?ticket=$some(team=$some(name=Core))"))).toEqual([]);
    expect(log).toEqual(["rel:ticket.team", "rel:ticket", "transformFilter"]);
  });

  it("applies to /pages, $count, $groupBy and $with sub-filters (path from this table)", async () => {
    const { Overlaid, log } = overlaid();
    const { controller, adapter } = bind(Overlaid);
    expect((await controller.pages("?ticket=$some(status=open)")).count).toBe(1);
    expect(await controller.query("?ticket=$some(status=open)&$count=true")).toBe(1);
    await controller.query("?ticket=$some(status=open)&$groupBy=title&$select=title,count(*):n");
    const agg = adapter.calls.findLast((c) => c.method === "aggregate")!.args[0].filter;
    expect(agg.ticket.$some.filter).toEqual({ $and: [{ teamId: "t1" }, { status: "open" }] });
    expect(log.filter((l) => l === "rel:ticket")).toHaveLength(3);

    const teamLog: string[] = [];
    class TeamOverlay extends AsDbReadableController {
      protected override transformRelationFilter(path: string, filter: FilterExpr) {
        teamLog.push(path);
        return path === "tickets.issues"
          ? ({ $and: [{ title: { $ne: "c" } }, filter] } as FilterExpr)
          : filter;
      }
    }
    const teams = bind(TeamOverlay, "teams").controller;
    const rows = await teams.query("?$with=tickets(issues=$some(title=c))");
    expect((rows as Array<{ tickets: unknown[] }>).every((t) => t.tickets.length === 0)).toBe(true);
    expect(teamLog).toEqual(["tickets.issues"]);
    await teams.getOne("t2", "?$with=tickets(issues=$some(title=c))");
    expect(teamLog).toEqual(["tickets.issues", "tickets.issues"]);
  });

  it("is inherited by the writable controller", async () => {
    const { Overlaid, log } = overlaid(AsDbController as unknown as TCtrl);
    const { controller } = bind(Overlaid);
    expect(ids(await controller.query("?ticket=$some(status=open)"))).toEqual([1]);
    expect(log[0]).toBe("rel:ticket");
  });

  it("is not called without client predicates", async () => {
    const { Overlaid, log } = overlaid();
    await bind(Overlaid).controller.query("?title=a");
    expect(log).toEqual(["transformFilter"]);
  });

  it("prepareRequest sees the parsed client filter in ctx.filter", async () => {
    const { Overlaid, contexts } = overlaid();
    const { controller } = bind(Overlaid);
    await controller.query("?ticket=$some(status=open)&title=a");
    expect(contexts[0]).toEqual({
      endpoint: "query",
      controls: {},
      filter: { ticket: { $some: { status: "open" } }, title: "a" },
    });
    await controller.pages("?$page=1");
    expect(contexts[1]!.filter).toBeUndefined();
    await controller.getOne("1", "");
    expect(contexts[2]!.filter).toBeUndefined();
  });
});

// ── Server-added predicates ($with row scopes in validateControls) ─────────

describe("server predicates conjoined into $with in validateControls", () => {
  /**
   * The pattern of a permission layer: `validateControls` conjoins the
   * related table's row scope into each `$with=tickets` entry — here a
   * predicate on `plainIssues`, a relation the CLIENT may not filter by.
   */
  function scoped(opts: { clone?: boolean; overlay?: boolean } = {}) {
    const hookLog: string[] = [];
    class Scoped extends AsDbReadableController {
      protected override validateControls(controls: Record<string, unknown>, type: any) {
        const error = super.validateControls(controls, type);
        if (error) return error;
        for (const entry of (controls.$with ?? []) as Array<Record<string, any>>) {
          if (entry?.name !== "tickets") continue;
          const scope = { plainIssues: { $some: { title: { $in: ["a", "c"] } } } };
          const client = opts.clone && entry.filter ? structuredClone(entry.filter) : entry.filter;
          entry.filter = client ? { $and: [scope, client] } : scope;
        }
        return undefined;
      }
      protected override transformRelationFilter(path: string, filter: FilterExpr) {
        if (!opts.overlay) return super.transformRelationFilter(path, filter);
        hookLog.push(path);
        return filter;
      }
    }
    return { controller: bind(Scoped, "teams").controller, hookLog };
  }

  const ticketsByTeam = (rows: unknown) =>
    Object.fromEntries(
      (rows as Array<{ id: string; tickets: Array<{ key: string }> }>).map((t) => [
        t.id,
        t.tickets.map((k) => k.key),
      ]),
    );

  it("are not gated as client input: a plain $with passes and the scope applies", async () => {
    const { controller } = scoped();
    expect(ticketsByTeam(await controller.query("?$with=tickets"))).toEqual({
      t1: ["k1"],
      t2: ["k3"],
    });
  });

  it("a client predicate in the same entry is still gated, counted and overlaid — the server one is not", async () => {
    const { controller, hookLog } = scoped({ overlay: true });
    expect(ticketsByTeam(await controller.query("?$with=tickets(issues=$some(title=c))"))).toEqual({
      t1: [],
      t2: ["k3"],
    });
    expect(hookLog).toEqual(["tickets.issues"]);
    // the client's own predicate on a non-filterable relation is still rejected
    expect(await rejected(controller.query("?$with=tickets(plainIssues=$some(title=c))"))).toEqual({
      path: "tickets.plainIssues",
      message:
        'Filtering by related "tickets.plainIssues" rows is not permitted — add @db.rel.filterable to enable.',
    });
  });

  it("server predicates do not consume the client's predicate budget", async () => {
    const { controller } = scoped();
    expect(Array.isArray(await controller.query(`?${manyPredicates(8)}&$with=tickets`))).toBe(true);
    expect(
      await rejected(
        controller.query(`?${manyPredicates(8)}&$with=tickets(issues=$some(title=c))`),
      ),
    ).toEqual({ path: "tickets.issues", message: "At most 8 relational predicates per query" });
  });

  it("fails closed when the hook replaced a client $with predicate by a copy", async () => {
    const { controller } = scoped({ clone: true, overlay: true });
    const err = await controller
      .query("?$with=tickets(issues=$some(title=c))")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).body.statusCode).toBe(500);
    // without a client predicate in $with there is nothing to overlay
    expect(Array.isArray(await controller.query("?$with=tickets"))).toBe(true);
  });

  it("a $with the server adds when the client sent none is not overlaid", async () => {
    const hookLog: string[] = [];
    class Adds extends AsDbReadableController {
      protected override validateControls(controls: Record<string, unknown>, type: any) {
        const error = super.validateControls(controls, type);
        if (error) return error;
        controls.$with ??= [{ name: "tickets", filter: { issues: { $some: { title: "c" } } } }];
        return undefined;
      }
      protected override transformRelationFilter(path: string, filter: FilterExpr) {
        hookLog.push(path);
        return filter;
      }
    }
    const { controller } = bind(Adds, "teams");
    expect(ticketsByTeam(await controller.query("?id=t2"))).toEqual({ t2: ["k3"] });
    expect(hookLog).toEqual([]);
  });
});

describe("core caps leave headroom above the client caps", () => {
  it("a client at the depth cap plus an overlay nesting one more level passes", async () => {
    class DeepOverlay extends AsDbReadableController {
      protected override transformRelationFilter(path: string, filter: FilterExpr) {
        return path === "ticket.team.tickets"
          ? ({ $and: [{ issues: { $some: {} } }, filter] } as FilterExpr)
          : filter;
      }
    }
    const { controller } = bind(DeepOverlay);
    expect(
      ids(await controller.query("?ticket=$some(team=$some(tickets=$some(status=open)))")),
    ).toEqual([1, 2, 3]);
  });

  it("8 client predicates plus a predicate per operand from the overlay pass", async () => {
    class WideOverlay extends AsDbReadableController {
      protected override transformRelationFilter(_path: string, filter: FilterExpr) {
        return { $and: [{ issues: { $some: {} } }, filter] } as FilterExpr;
      }
    }
    const { controller } = bind(WideOverlay, "teams");
    expect(Array.isArray(await controller.query(`?${manyPredicates(8)}`))).toBe(true);
  });

  it("beyond the core cap the error names no path or count of the server's predicates", async () => {
    class Wider extends AsDbReadableController {
      protected override transformRelationFilter(_path: string, filter: FilterExpr) {
        return { $and: [{ issues: { $some: {} } }, filter] } as FilterExpr;
      }
      protected override transformFilter(filter: FilterExpr) {
        return { $and: [{ tickets: { $none: { status: "zzz" } } }, filter] } as FilterExpr;
      }
    }
    const { controller } = bind(Wider, "teams");
    const err = await controller.query(`?${manyPredicates(8)}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).errors).toEqual([
      { path: "", message: "At most 16 relational predicates per query" },
    ]);
  });
});

describe("TDbRequestContext.filter is a frozen copy", () => {
  it("a hook mutating ctx.filter cannot change what the gate judges or the read uses", async () => {
    let seen: unknown;
    class Mutating extends AsDbReadableController {
      protected async prepareRequest(ctx: TDbRequestContext): Promise<void> {
        seen = ctx.filter;
        expect(Object.isFrozen(ctx.filter)).toBe(true);
        expect(() => {
          (ctx.filter as any).ticket = { $some: {} };
        }).toThrow();
      }
    }
    const { controller } = bind(Mutating);
    expect(ids(await controller.query("?title=a"))).toEqual([1]);
    expect(seen).toEqual({ title: "a" });
  });
});

// ── /meta ───────────────────────────────────────────────────────────────────

describe("/meta", () => {
  it("relations[].filterable is present exactly on @db.rel.filterable relations", async () => {
    const meta = await bind().controller.meta();
    expect(meta.relations).toEqual([
      { name: "ticket", direction: "to", isArray: false, filterable: true },
      { name: "ticketPlain", direction: "to", isArray: false },
      { name: "board", direction: "to", isArray: false, filterable: true },
    ]);
  });
});

// ── Server-side predicates and identifications (real HTTP) ──────────────────

let PREFIX_SEQ = 0;

async function bootIssues(scope?: (action: string) => FilterExpr | undefined) {
  getMoostInfact()._cleanup();
  const { issues } = space();
  const prefix = `relpred${++PREFIX_SEQ}`;

  @TableController(issues, prefix)
  class Issues extends AsDbController {
    protected override actionRowScope(action: string) {
      return scope?.(action);
    }

    @Post("actions/resolve")
    @DbAction("resolve", { label: "resolve" })
    resolve(@DbActionID() id: unknown) {
      return { id };
    }

    @Post("actions/tag")
    @DbAction("tag", { label: "tag" })
    tag(@DbActionID() id: unknown) {
      return { id };
    }
  }
  const http = await bootHttp(Issues);
  const send = (method: string, path: string, body?: unknown, sep = "/") =>
    http(method, `/${prefix}${sep}${path}`, body);
  return { send };
}

describe("actionRowScope may return a predicate (server-side, no opt-in needed)", () => {
  const OPEN_T1 = {
    ticket: { $some: { teamId: { $in: ["t1"] }, status: "open" } },
  } as FilterExpr;
  const scope = (action: string) => (action === "resolve" ? OPEN_T1 : undefined);

  it("drives the action gate, $actions and GET /meta/actions/:id", async () => {
    const { send } = await bootIssues(scope);
    expect((await send("POST", "actions/resolve", { ids: { id: 1 } })).status).toBe(201);
    const outside = await send("POST", "actions/resolve", { ids: { id: 3 } });
    expect(outside.status).toBe(404);
    expect(outside.body.message).toBe("Row not found for action identifier");
    expect((await send("POST", "actions/tag", { ids: { id: 3 } })).status).toBe(201);

    const rows = (await send("GET", "query?$actions=true")).body as Array<{
      id: number;
      $actions: string[];
    }>;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.$actions]))).toEqual({
      1: ["resolve", "tag"],
      2: ["tag"],
      3: ["tag"],
      4: ["tag"],
    });
    expect((await send("GET", "meta/actions/1")).body).toEqual({ actions: ["resolve", "tag"] });
    expect((await send("GET", "meta/actions/3")).body).toEqual({ actions: ["tag"] });
  });

  it("predicates are never identifications: /one, DELETE and action ids reject them", async () => {
    const { send } = await bootIssues();
    const one = await send("GET", "one?ticket=$some(status%3Dopen)");
    expect(one.status).toBe(400);
    expect(one.body.message).toBe("Query params do not match any primary key or unique index");
    const oneById = await send("GET", "one/1?ticket=$some(status%3Dopen)");
    expect(oneById.status).toBe(400);
    expect(oneById.body.message).toBe('Filtering is not allowed for "one" endpoint');
    const del = await send("DELETE", "?ticket=$some(status%3Dopen)", undefined, "");
    expect(del.status).toBe(400);
    expect(del.body.message).toBe("Query params do not match any primary key or unique index");
    const metaActions = await send("GET", "meta/actions?ticket=$some(status%3Dopen)");
    expect(metaActions.status).toBe(400);

    const byNav = await send("POST", "actions/tag", { ids: { ticket: { $some: {} } } });
    expect(byNav.status).toBe(400);
    expect(JSON.stringify(byNav.body)).toContain("Identifier fields must exactly match one of");
    const byOp = await send("POST", "actions/tag", { ids: { id: { $some: {} } } });
    expect(byOp.status).toBe(400);
    expect(JSON.stringify(byOp.body)).toContain("Expected identifier value to be");
  });
});

describe("query targets", () => {
  async function bootTargets(overlay: boolean) {
    getMoostInfact()._cleanup();
    const { issues } = space();
    const prefix = `relpred${++PREFIX_SEQ}`;
    const hook: string[] = [];

    @TableController(issues, prefix)
    class Issues extends AsDbController {
      protected override transformRelationFilter(path: string, filter: FilterExpr) {
        hook.push(path);
        return overlay && path === "ticket"
          ? ({ $and: [{ teamId: "t1" }, filter] } as FilterExpr)
          : filter;
      }

      @Post("actions/close")
      @DbAction("close", { label: "close", queryTarget: true })
      close(@DbActionIDs() ids: unknown) {
        return { ids };
      }
    }
    const http = await bootHttp(Issues);
    const target = async (q: string) =>
      (await http("POST", `/${prefix}/actions/close`, { query: { q } })).body as {
        ids: Array<{ id: number }>;
      };
    return { target, hook };
  }

  it("a client predicate in the target's filter takes the transformRelationFilter overlay", async () => {
    const plain = await bootTargets(false);
    const all = (await plain.target("ticket=$some(status=open)")).ids.map((i) => i.id);
    expect(all.length).toBeGreaterThan(1);
    const { target, hook } = await bootTargets(true);
    expect((await target("ticket=$some(status=open)")).ids).toEqual([{ id: 1 }]);
    expect(hook).toContain("ticket");
  });
});
