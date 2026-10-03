/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import type { FilterExpr } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { HttpError, Post } from "@moostjs/event-http";
import { Inherit, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import type { TDbRequestContext } from "../as-readable.controller";
import { TableController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { DbActionRows } from "../actions/db-action-row.decorator";
import type { TDbActionScopeContext } from "../actions/scope-context";
import { filterKey } from "../actions/scope-context";
import { bootHttp, prepareFixtures } from "./test-utils";

/**
 * `actionRowScope(action, ctx)` (since 0.1.147): the hook receives the
 * candidate rows — their identities (`ctx.ids`, one array per evaluation),
 * `ctx.loadRows(fields)` and `ctx.purpose` — so a scope can be derived from
 * them (here: issues whose ticket belongs to the caller's team).
 */

let FwIssue: any;
let FwTicket: any;

const TICKETS = [
  { key: "T1", teamId: "a", status: "open" },
  { key: "T2", teamId: "b", status: "open" },
  { key: "T3", teamId: "a", status: "closed" },
];
const ISSUES = [
  { id: 1, ticketKey: "T1", status: "open", title: "one", secret: "s1" },
  { id: 2, ticketKey: "T2", status: "open", title: "two", secret: "s2" },
  { id: 3, ticketKey: "T3", status: "open", title: "three", secret: "s3" },
  { id: 4, ticketKey: "T1", status: "done", title: "four", secret: "s4" },
];

interface TCall {
  action: string;
  purpose: string;
  ids: readonly Record<string, unknown>[];
}

let SEQ = 0;

async function boot(
  opts: {
    overlay?: FilterExpr;
    hook?: (action: string, ctx: TDbActionScopeContext) => Promise<FilterExpr | undefined>;
    order?: string[];
  } = {},
) {
  getMoostInfact()._cleanup();
  const space = createAdapter();
  const tickets = space.getTable(FwTicket);
  const issues = space.getTable(FwIssue);
  await tickets.insertMany(structuredClone(TICKETS) as never);
  await issues.insertMany(structuredClone(ISSUES) as never);
  const calls: TCall[] = [];
  const handled: unknown[] = [];
  const order = opts.order;
  const team = "a";
  const teamScope =
    opts.hook ??
    (async (action: string, ctx: TDbActionScopeContext) => {
      if (action === "approve") return undefined;
      const rows = await ctx.loadRows(["ticketKey"]);
      const own = await tickets.findMany({
        filter: { key: { $in: rows.map((r) => r.ticketKey) }, teamId: team },
        controls: { $select: ["key"] },
      } as never);
      return { ticketKey: { $in: own.map((t: any) => t.key) } } as FilterExpr;
    });
  const prefix = `cand${++SEQ}`;

  @TableController(issues, prefix)
  @Inherit()
  class IssueCtrl extends AsDbController {
    protected async prepareRequest(ctx: TDbRequestContext) {
      order?.push(`prepare:${ctx.endpoint}`);
    }

    protected override transformOne(filter: FilterExpr): FilterExpr {
      order?.push("overlay");
      return opts.overlay ? ({ $and: [filter, opts.overlay] } as FilterExpr) : filter;
    }

    protected override async actionRowScope(action: string, ctx: TDbActionScopeContext) {
      order?.push("scope");
      calls.push({ action, purpose: ctx.purpose, ids: ctx.ids });
      return teamScope(action, ctx);
    }

    @Post("actions/resolve")
    @DbAction("resolve", { label: "Resolve" })
    resolve(@DbActionID() id: unknown) {
      handled.push(id);
      return { id };
    }

    @Post("actions/bulk")
    @DbAction("bulk", { label: "Bulk", onDisabledRows: "skip" })
    bulk(@DbActionIDs() ids: unknown) {
      handled.push(ids);
      return { ids };
    }

    @Post("actions/bulkRows")
    @DbAction("bulkRows", { label: "Bulk rows" })
    bulkRows(@DbActionRows() rows: unknown) {
      handled.push(rows);
      return { rows };
    }

    @Post("actions/approve")
    @DbAction("approve", { label: "Approve" })
    approve(@DbActionID() id: unknown) {
      return { id };
    }
  }

  const http = await bootHttp(IssueCtrl);
  const findMany = vi.spyOn(issues, "findMany");
  const send = (method: string, path: string, body?: unknown) =>
    http(method, `/${prefix}/${path}`, body);
  return { send, calls, handled, findMany };
}

beforeAll(async () => {
  await prepareFixtures();
  ({ FwIssue, FwTicket } = await import("./fixtures/fw3-actions.as"));
});

const actionsOf = (rows: Array<{ id: number; $actions: string[] }>) =>
  Object.fromEntries(rows.map((r) => [r.id, r.$actions]));

describe("actionRowScope(action, ctx) — $actions (purpose: rows)", () => {
  it("derives the scope from the candidates; one ids array per evaluation, deduped", async () => {
    const { send, calls } = await boot();
    const res = await send("GET", "query?$actions=true&$sort=id");
    expect(res.status).toBe(200);
    expect(actionsOf(res.body)).toEqual({
      1: ["resolve", "bulk", "bulkRows", "approve"],
      2: ["approve"],
      3: ["resolve", "bulk", "bulkRows", "approve"],
      4: ["resolve", "bulk", "bulkRows", "approve"],
    });
    expect(calls.map((c) => [c.action, c.purpose])).toEqual([
      ["resolve", "rows"],
      ["bulk", "rows"],
      ["bulkRows", "rows"],
      ["approve", "rows"],
    ]);
    expect(calls[0].ids).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    for (const call of calls) expect(call.ids).toBe(calls[0].ids);
  });

  it("is bounded by the page and never called for an empty one", async () => {
    const { send, calls } = await boot();
    await send("GET", "query?$actions=true&$sort=id&$limit=2");
    expect(calls[0].ids).toEqual([{ id: 1 }, { id: 2 }]);
    calls.length = 0;
    expect((await send("GET", "query?$actions=true&status=nope")).body).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("equal filters built per action share one scope query", async () => {
    const { send, findMany } = await boot();
    await send("GET", "query?$actions=true&$sort=id");
    // the read, one loadRows (memoized across the three actions), one scope query
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("loadRows reads hidden / unselected fields without leaking them", async () => {
    const seen: unknown[] = [];
    const { send } = await boot({
      hook: async (action, ctx) => {
        if (action !== "resolve") return undefined;
        const rows = await ctx.loadRows(["secret"]);
        seen.push(rows);
        expect(await ctx.loadRows(["secret"])).toBe(rows);
        return {
          id: { $in: rows.filter((r) => r.secret !== "s3").map((r) => r.id) },
        } as FilterExpr;
      },
    });
    const res = await send("GET", "query?$actions=true&$sort=id&$select=id,title");
    expect(res.body[2].$actions).not.toContain("resolve");
    expect(res.body[0].$actions).toContain("resolve");
    for (const row of res.body) expect(row).not.toHaveProperty("secret");
    expect(seen[0]).toEqual(ISSUES.map(({ id, secret }) => ({ id, secret })));
  });

  it("a throwing hook fails the read (never a silent allow)", async () => {
    const { send } = await boot({
      hook: async () => {
        throw new HttpError(403, "no");
      },
    });
    expect((await send("GET", "query?$actions=true")).status).toBe(403);
  });
});

describe("actionRowScope(action, ctx) — GET /meta/actions/:id (purpose: available)", () => {
  it("is asked about the one row", async () => {
    const { send, calls } = await boot();
    expect((await send("GET", "meta/actions/2")).body).toEqual({ actions: ["approve"] });
    expect(calls.every((c) => c.purpose === "available")).toBe(true);
    expect(calls[0].ids).toEqual([{ id: 2 }]);
    calls.length = 0;
    expect((await send("GET", "meta/actions/99")).body).toEqual({ actions: [] });
    expect(calls).toEqual([]);
  });
});

describe("actionRowScope(action, ctx) — the action gate (purpose: execute)", () => {
  it("'row': a candidate outside the derived scope is a 404; inside runs", async () => {
    const { send, calls, handled } = await boot();
    const refused = await send("POST", "actions/resolve", { ids: { id: 2 } });
    expect(refused.status).toBe(404);
    expect(refused.body.message).toBe("Row not found for action identifier");
    expect(calls).toEqual([{ action: "resolve", purpose: "execute", ids: [{ id: 2 }] }]);
    expect((await send("POST", "actions/resolve", { ids: { id: 1 } })).status).toBe(201);
    expect(handled).toEqual([{ id: 1 }]);
  });

  it("'rows': the hook sees the loaded rows only; out-of-scope ids follow onDisabledRows", async () => {
    const { send, calls, handled } = await boot();
    const res = await send("POST", "actions/bulk", { ids: [{ id: 1 }, { id: 2 }, { id: 99 }] });
    expect(res.status).toBe(201);
    expect(res.body.ids).toEqual([{ id: 1 }]);
    expect(calls).toEqual([{ action: "bulk", purpose: "execute", ids: [{ id: 1 }, { id: 2 }] }]);
    const rejected = await send("POST", "actions/bulkRows", { ids: [{ id: 1 }, { id: 2 }] });
    expect(rejected.status).toBe(409);
    expect(rejected.body.ids).toEqual([{ id: 2 }]);
    expect(handled).toHaveLength(1);
  });

  it("ids outside the row overlay never reach the hook", async () => {
    const { send, calls } = await boot({ overlay: { status: "open" } as FilterExpr });
    await send("POST", "actions/bulk", { ids: [{ id: 1 }, { id: 4 }] });
    expect(calls[0].ids).toEqual([{ id: 1 }]);
  });

  it("order: prepareRequest → row overlay → (body) → actionRowScope", async () => {
    const order: string[] = [];
    const { send } = await boot({ order });
    await send("POST", "actions/resolve", { ids: { id: 1 } });
    expect(order).toEqual(["prepare:action", "overlay", "scope"]);
  });

  it("an action the hook does not scope runs with no scope query", async () => {
    const { send, findMany } = await boot();
    expect((await send("POST", "actions/approve", { ids: { id: 2 } })).status).toBe(201);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("filterKey", () => {
  it("is structural for plain filters, tags dates / regexps / ObjectIds, refuses other classes", () => {
    expect(filterKey({ a: 1, b: { $in: [1, 2] } } as FilterExpr)).toBe(
      filterKey({ b: { $in: [1, 2] }, a: 1 } as FilterExpr),
    );
    expect(filterKey({ a: 1 } as FilterExpr)).not.toBe(filterKey({ a: 2 } as FilterExpr));
    const at = new Date("2026-01-01T00:00:00Z");
    expect(filterKey({ at } as FilterExpr)).toBe(filterKey({ at: new Date(at) } as FilterExpr));
    expect(filterKey({ at } as FilterExpr)).not.toBe(
      filterKey({ at: at.toISOString() } as FilterExpr),
    );
    expect(filterKey({ r: /x/i } as FilterExpr)).not.toBe(filterKey({ r: /x/ } as FilterExpr));
    const oid = { toHexString: () => "abc" };
    expect(filterKey({ o: oid } as FilterExpr)).toBe(
      filterKey({ o: { toHexString: () => "abc" } } as FilterExpr),
    );
    class Opaque {}
    expect(filterKey({ o: new Opaque() } as FilterExpr)).toBeUndefined();
  });

  it("L2: no collisions — tag-shaped plain objects, non-finite numbers and -0 never share a key", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const pairs: Array<[unknown, unknown]> = [
      [{ at }, { at: { $date: at.toISOString() } }],
      [{ r: /x/i }, { r: { $regexp: "x", flags: "i" } }],
      [{ o: { toHexString: () => "abc" } }, { o: { $oid: "abc" } }],
      [{ b: 10n }, { b: { $bigint: "10" } }],
      [{ u: undefined }, { u: { $undefined: 1 } }],
      [{ "#date": 1 }, { at: 1 }],
    ];
    for (const [a, b] of pairs) {
      expect(filterKey(a as FilterExpr)).not.toBe(filterKey(b as FilterExpr));
    }
    for (const v of [Number.NaN, Infinity, -Infinity, -0]) {
      expect(filterKey({ n: v } as FilterExpr)).toBeUndefined();
    }
    expect(filterKey({ n: 0 } as FilterExpr)).toBeDefined();
  });
});
