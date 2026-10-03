/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import type { FilterExpr } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { HttpError, Post } from "@moostjs/event-http";
import { Inherit, current, getMoostInfact, key } from "moost";

import { AsDbController } from "../as-db.controller";
import type { TDbRequestContext } from "../as-readable.controller";
import { TableController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { DbActionRows } from "../actions/db-action-row.decorator";
import type { TDbActionScopeContext } from "../actions/scope-context";
import { DbActionTarget, useDbActionTarget, type TDbActionTarget } from "../actions/target";
import { bootHttp, prepareFixtures } from "./test-utils";

/**
 * Query targets (since 0.1.147): `{ query: { q, exclude?, expectCount?,
 * maxRows?, dryRun? } }` instead of `{ ids }` on a `'rows'` action declaring
 * `queryTarget` — resolved once (phase 1, under the row overlay and the read
 * scope), then re-checked per batch (stale rows skipped).
 */

let FwIssue: any;
let FwTicket: any;

/** A fresh memory space with the tickets the issues reference. */
async function issuesTable() {
  const space = createAdapter();
  await space
    .getTable(FwTicket)
    .insertMany(["T1", "T2", "T3"].map((key) => ({ key, teamId: "a", status: "open" })) as never);
  return space.getTable(FwIssue);
}

const ISSUES = [
  { id: 1, ticketKey: "T1", status: "open", title: "alpha one", secret: "x" },
  { id: 2, ticketKey: "T1", status: "open", title: "alpha two", secret: "x" },
  { id: 3, ticketKey: "T2", status: "closed", title: "beta three", secret: "y" },
  { id: 4, ticketKey: "T2", status: "open", title: "beta four", secret: "y" },
  { id: 5, ticketKey: "T3", status: "open", title: "gamma five", secret: "z" },
];

const closedRows = (rows: Array<{ status?: string }>) =>
  rows.map((r) => (r.status === "closed" ? "already closed" : false));

let SEQ = 0;

interface TBoot {
  readScope?: FilterExpr;
  rowScope?: FilterExpr;
  hideSecret?: boolean;
  deny?: boolean;
  scopeHook?: (action: string, ctx: TDbActionScopeContext) => FilterExpr | undefined;
  onBatch?: (batch: number, table: any) => Promise<void>;
  /** A field hidden on READ requests only (the action request sees it). */
  hideOnRead?: string;
  /** A read scope applied on READ requests only (the action overlay is unrestricted). */
  readOnlyScope?: FilterExpr;
  /** The caller holds no read grant (prepareRequest refuses `query`). */
  actionOnly?: boolean;
  /** validateControls refuses `$search`. */
  denySearch?: boolean;
  /** The streamed handler throws on this batch (0-based). */
  failOnBatch?: number;
  /** Collects the `prepareRequest` contexts of READ (`query`) requests. */
  readContexts?: TDbRequestContext[];
}

/** The endpoint `prepareRequest` saw in the current (child) event. */
const endpointKey = key<string>("qt.endpoint");
const endpoint = () => (current().has(endpointKey) ? current().get(endpointKey) : undefined);

async function boot(opts: TBoot = {}) {
  getMoostInfact()._cleanup();
  const issues = await issuesTable();
  await issues.insertMany(structuredClone(ISSUES) as never);
  const handled: Array<{ action: string; ids: unknown; summary?: unknown }> = [];
  const scopeCalls: Array<readonly Record<string, unknown>[]> = [];
  const prefix = `qt${++SEQ}`;

  @TableController(issues, prefix)
  @Inherit()
  class IssueCtrl extends AsDbController {
    protected async prepareRequest(ctx: TDbRequestContext) {
      if (opts.deny && ctx.endpoint === "action") throw new HttpError(403, "denied");
      if (opts.actionOnly && ctx.endpoint === "query") throw new HttpError(403, "no read grant");
      if (ctx.endpoint === "query") opts.readContexts?.push(ctx);
      current().set(endpointKey, ctx.endpoint);
    }

    protected override transformFilter(filter: FilterExpr): FilterExpr {
      const scope = opts.readScope ?? (endpoint() === "query" ? opts.readOnlyScope : undefined);
      return scope ? ({ $and: [filter, scope] } as FilterExpr) : filter;
    }

    protected override validateControls(controls: Record<string, unknown>, type: never) {
      if (opts.denySearch && controls.$search !== undefined) return "$search is not allowed";
      return super.validateControls(controls, type);
    }

    protected override transformOne(filter: FilterExpr): FilterExpr {
      return opts.rowScope ? ({ $and: [filter, opts.rowScope] } as FilterExpr) : filter;
    }

    protected override hasField(path: string): boolean {
      if (opts.hideOnRead === path && endpoint() === "query") return false;
      return (!opts.hideSecret || path !== "secret") && super.hasField(path);
    }

    protected override actionRowScope(action: string, ctx: TDbActionScopeContext) {
      scopeCalls.push(ctx.ids);
      return opts.scopeHook?.(action, ctx);
    }

    @Post("actions/close")
    @DbAction("close", { label: "Close", queryTarget: { maxRows: 4 } })
    close(@DbActionIDs() ids: unknown) {
      handled.push({ action: "close", ids, summary: useDbActionTarget().summary() });
      return { ids };
    }

    @Post("actions/closeRows")
    @DbAction("closeRows", {
      label: "Close rows",
      requiredFields: ["status"],
      disabled: closedRows,
      onDisabledRows: "skip",
      queryTarget: true,
    })
    closeRows(@DbActionRows() rows: Array<{ id: number }>) {
      handled.push({
        action: "closeRows",
        ids: rows.map((r) => r.id),
        summary: useDbActionTarget().summary(),
      });
      return { count: rows.length };
    }

    @Post("actions/closeStrict")
    @DbAction("closeStrict", {
      label: "Close strict",
      requiredFields: ["status"],
      disabled: closedRows,
      queryTarget: true,
    })
    closeStrict(@DbActionIDs() ids: unknown) {
      handled.push({ action: "closeStrict", ids });
      return { ids };
    }

    @Post("actions/stream")
    @DbAction("stream", {
      label: "Stream",
      requiredFields: ["status"],
      disabled: closedRows,
      queryTarget: { maxRows: 100, batchSize: 2 },
    })
    async stream(@DbActionTarget() target: TDbActionTarget<{ id: number; status: string }>) {
      let batch = 0;
      for await (const { ids, rows } of target.batches()) {
        handled.push({ action: "stream", ids: rows.map((r) => r.id) });
        if (ids.some((id) => id.id === 2)) target.fail({ id: 2 }, "locked");
        if (opts.failOnBatch === batch) throw new HttpError(503, "backend down");
        await opts.onBatch?.(batch, issues);
        batch++;
      }
      return target.summary();
    }

    @Post("actions/plain")
    @DbAction("plain", { label: "Plain" })
    plain(@DbActionIDs() ids: unknown) {
      return { ids };
    }

    @Post("actions/one")
    @DbAction("one", { label: "One", queryTarget: true })
    one(@DbActionID() id: unknown) {
      return { id };
    }
  }

  const http = await bootHttp(IssueCtrl);
  const send = (action: string, body: unknown) =>
    http("POST", `/${prefix}/actions/${action}`, body);
  const query = (action: string, q: string, extra: Record<string, unknown> = {}, input?: unknown) =>
    send(action, { query: { q, ...extra }, ...(input === undefined ? {} : { input }) });
  const meta = async () => (await http("GET", `/${prefix}/meta`)).body;
  return { send, query, meta, handled, scopeCalls, issues };
}

beforeAll(async () => {
  await prepareFixtures();
  ({ FwIssue, FwTicket } = await import("./fixtures/fw3-actions.as"));
});

describe("query targets — the envelope", () => {
  it("ids and query together → 400 TARGET_INVALID", async () => {
    const { send } = await boot();
    const res = await send("close", { ids: [{ id: 1 }], query: { q: "" } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      name: "ActionTargetError",
      code: "TARGET_INVALID",
      action: "close",
    });
  });

  it("an action without queryTarget refuses a query", async () => {
    const { query } = await boot();
    const res = await query("plain", "status=open");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TARGET_INVALID");
  });

  it("controls other than $search / $index, unknown keys and bad types → 400", async () => {
    const { query, send } = await boot();
    for (const q of [
      "$sort=id",
      "$limit=2",
      "$select=id",
      "$vector=x&$search=a",
      "$with=ticketKey",
    ]) {
      const res = await query("close", q);
      expect(res.status, q).toBe(400);
      expect(res.body.code, q).toBe("TARGET_INVALID");
    }
    expect((await send("close", { query: { q: "", extra: 1 } })).body.code).toBe("TARGET_INVALID");
    expect((await send("close", { query: { q: 1 } })).body.code).toBe("TARGET_INVALID");
    expect((await send("close", { query: { q: "", expectCount: -1 } })).body.code).toBe(
      "TARGET_INVALID",
    );
  });

  it("unknown and hasField-hidden filter fields answer like /query (Unknown field)", async () => {
    const { query } = await boot({ hideSecret: true });
    const unknown = await query("close", "nope=1");
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors[0]).toMatchObject({ path: "nope" });
    const hidden = await query("close", "secret=x");
    expect(hidden.status).toBe(400);
    expect(hidden.body.errors[0].message).toBe(
      unknown.body.errors[0].message.replace("nope", "secret"),
    );
  });

  it("prepareRequest runs before the body is read", async () => {
    const { send } = await boot({ deny: true });
    expect((await send("close", { query: { q: "", bogus: true } })).status).toBe(403);
  });

  it("/meta advertises queryTarget.maxRows; a 'row' action with queryTarget is dropped", async () => {
    const { meta } = await boot();
    const m = await meta();
    const byName = Object.fromEntries(m.actions.map((a: any) => [a.name, a]));
    expect(byName.close.queryTarget).toEqual({ maxRows: 4 });
    // a materialized handler takes the whole target as one id list: capped by maxIds too
    expect(byName.closeRows.queryTarget).toEqual({ maxRows: 1000 });
    expect(byName.stream.queryTarget).toEqual({ maxRows: 100 });
    expect(byName.plain.queryTarget).toBeUndefined();
    expect(byName.one).toBeUndefined();
  });
});

describe("query targets — phase 1 (resolve)", () => {
  it("runs the handler on the matching rows (materialized); matched in the summary", async () => {
    const { query, handled } = await boot();
    const res = await query("close", "ticketKey=T1");
    expect(res.status).toBe(201);
    expect(res.body.ids).toEqual([{ id: 1 }, { id: 2 }]);
    expect(handled[0].summary).toEqual({ matched: 2, processed: 2, skipped: [], failed: [] });
  });

  it("$search (searchable fallback) and filter compose", async () => {
    const { query } = await boot();
    expect((await query("close", "$search=beta")).body.ids).toEqual([{ id: 3 }, { id: 4 }]);
    expect((await query("close", "$search=beta&status=open")).body.ids).toEqual([{ id: 4 }]);
  });

  it("more rows than the cap (maxRows, client maxRows) → 400 TARGET_TOO_LARGE", async () => {
    const { query, handled } = await boot();
    const res = await query("close", "");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "TARGET_TOO_LARGE", cap: 4 });
    const client = await query("close", "ticketKey=T1", { maxRows: 1 });
    expect(client.body).toMatchObject({ code: "TARGET_TOO_LARGE", cap: 1 });
    expect(handled).toEqual([]);
  });

  it("expectCount mismatch → 409 TARGET_CHANGED with the current count", async () => {
    const { query, handled } = await boot();
    const res = await query("close", "ticketKey=T1", { expectCount: 3 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "TARGET_CHANGED", matched: 2 });
    expect((await query("close", "ticketKey=T1", { expectCount: 2 })).status).toBe(201);
    expect(handled).toHaveLength(1);
  });

  it("dryRun answers { matched } and never runs the handler", async () => {
    const { query, handled } = await boot();
    const res = await query("closeRows", "status=open", { dryRun: true });
    expect(res.body).toEqual({ matched: 4 });
    const streamed = await query("stream", "", { dryRun: true });
    expect(streamed.body).toEqual({ matched: 5 });
    expect(handled).toEqual([]);
  });

  it("exclude leaves rows out (any identification, validated)", async () => {
    const { query } = await boot();
    const res = await query("close", "ticketKey=T1", { exclude: [{ id: 2 }] });
    expect(res.body.ids).toEqual([{ id: 1 }]);
    const bad = await query("close", "ticketKey=T1", { exclude: [{ nope: 2 }] });
    expect(bad.status).toBe(400);
  });

  it("resolves under the read scope (queryTargetScope default) AND the row overlay", async () => {
    const { query } = await boot({
      readScope: { ticketKey: { $in: ["T1", "T2"] } } as FilterExpr,
      rowScope: { status: "open" } as FilterExpr,
    });
    const res = await query("close", "");
    expect(res.body.ids).toEqual([{ id: 1 }, { id: 2 }, { id: 4 }]);
  });
});

describe("query targets — the gate (materialized)", () => {
  it("'skip' records the skipped rows with their reasons", async () => {
    const { query, handled } = await boot();
    const res = await query("closeRows", "");
    expect(res.status).toBe(201);
    expect(handled[0].ids).toEqual([1, 2, 4, 5]);
    expect(handled[0].summary).toEqual({
      matched: 5,
      processed: 4,
      skipped: [{ id: { id: 3 }, reason: "already closed" }],
      failed: [],
    });
  });

  it("'reject' refuses the whole target with the failing ids", async () => {
    const { query, handled } = await boot();
    const res = await query("closeStrict", "ticketKey=T2");
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ name: "ActionDisabledError", ids: [{ id: 3 }] });
    expect(handled).toEqual([]);
  });

  it("actionRowScope applies to the target's rows", async () => {
    const { query, handled } = await boot({
      scopeHook: (action) =>
        action === "closeRows" ? ({ ticketKey: "T1" } as FilterExpr) : undefined,
    });
    await query("closeRows", "status=open");
    expect(handled[0].ids).toEqual([1, 2]);
    expect(handled[0].summary).toMatchObject({
      matched: 4,
      skipped: [{ id: { id: 4 } }, { id: { id: 5 } }],
    });
  });
});

describe("query targets — @DbActionTarget (streamed)", () => {
  it("gates and yields batch by batch; fail() and skips land in the summary", async () => {
    const { query, handled, scopeCalls } = await boot();
    const res = await query("stream", "");
    expect(res.status).toBe(201);
    expect(handled.map((h) => h.ids)).toEqual([[1, 2], [4], [5]]);
    expect(res.body).toEqual({
      matched: 5,
      processed: 3,
      skipped: [{ id: { id: 3 }, reason: "already closed" }],
      failed: [{ id: { id: 2 }, reason: "locked" }],
    });
    // actionRowScope once per batch, never more than batchSize ids
    expect(scopeCalls.map((ids) => ids.length)).toEqual([2, 2, 1]);
  });

  it("a row changed out of the query after phase 1 is skipped as stale", async () => {
    const { query, handled } = await boot({
      onBatch: async (batch, table) => {
        if (batch === 0) await table.updateOne({ id: 4, status: "archived" });
      },
    });
    const res = await query("stream", "status=open");
    expect(handled.map((h) => h.ids)).toEqual([[1, 2], [5]]);
    expect(res.body.skipped).toEqual([{ id: { id: 4 }, reason: "stale" }]);
  });

  it("serves id targets too (kind: ids)", async () => {
    const { send, handled } = await boot();
    const res = await send("stream", { ids: [{ id: 3 }, { id: 4 }, { id: 99 }] });
    expect(handled.map((h) => h.ids)).toEqual([[4]]);
    expect(res.body).toEqual({
      matched: 3,
      processed: 1,
      skipped: [{ id: { id: 3 }, reason: "already closed" }, { id: { id: 99 } }],
      failed: [],
    });
  });

  it("resolves under the row overlay; an out-of-overlay id is skipped like a missing one", async () => {
    const { send, query } = await boot({ rowScope: { ticketKey: "T1" } as FilterExpr });
    expect((await query("stream", "", { dryRun: true })).body).toEqual({ matched: 2 });
    const res = await send("stream", { ids: [{ id: 1 }, { id: 5 }] });
    expect(res.body.skipped).toEqual([{ id: { id: 5 } }]);
  });
});

describe("query targets — discovery", () => {
  it("@DbActionTarget mixed with @DbActionIDs is dropped; queryTarget on a row action is dropped", async () => {
    getMoostInfact()._cleanup();
    const issues = await issuesTable();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    @TableController(issues, `qtdisc${++SEQ}`)
    class Disc extends AsDbController {
      @Post("actions/mixed")
      @DbAction("mixed", { label: "Mixed" })
      mixed(@DbActionTarget() _t: unknown, @DbActionIDs() _ids: unknown) {
        return 1;
      }
    }
    const http = await bootHttp(Disc);
    const res = await http("GET", `/qtdisc${SEQ}/meta`);
    expect(res.body.actions.map((a: any) => a.name)).not.toContain("mixed");
    warn.mockRestore();
  });
});

describe("query targets — validated and scoped as a READ (since 0.1.147)", () => {
  it("SECURITY: a field the read grant hides can't filter a target — no count oracle", async () => {
    const { query, handled } = await boot({ hideOnRead: "secret" });
    for (const extra of [{ dryRun: true }, {}]) {
      const res = await query("close", "secret=x", extra);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/secret/);
    }
    // excluding by a read-hidden identification is refused too
    expect((await query("close", "", { exclude: [{ secret: "x" }] })).status).toBe(400);
    expect(handled).toEqual([]);
  });

  it("the default queryTargetScope is the READ overlay — even when the action overlay is wider", async () => {
    const { query, handled } = await boot({
      readOnlyScope: { ticketKey: "T1" } as FilterExpr,
    });
    expect((await query("close", "", { dryRun: true })).body).toEqual({ matched: 2 });
    const res = await query("closeRows", "");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(handled[0].ids).toEqual([1, 2]);
  });

  it("an action-only caller (no read grant) can't use a query target — ids still work", async () => {
    const { query, send, handled } = await boot({ actionOnly: true });
    expect((await query("close", "", { dryRun: true })).status).toBe(403);
    expect((await query("close", "status=open")).status).toBe(403);
    expect((await send("close", { ids: [{ id: 1 }] })).status).toBe(201);
    expect(handled.map((h) => h.ids)).toEqual([[{ id: 1 }]]);
  });

  it("the read's prepareRequest sees the target's client filter in ctx.filter", async () => {
    const readContexts: TDbRequestContext[] = [];
    const { query } = await boot({ readContexts });
    expect((await query("close", "status=open", { dryRun: true })).status).toBe(201);
    expect(readContexts.map((c) => c.filter)).toEqual([{ status: "open" }]);
  });

  it("validateControls applies to the target's controls (per-control authorization)", async () => {
    const { query, handled } = await boot({ denySearch: true });
    const res = await query("close", "$search=alpha", { dryRun: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("$search is not allowed");
    expect((await query("close", "id=1")).status).toBe(201);
    expect(handled).toHaveLength(1);
  });
});

describe("query targets — a query matching nothing never runs the handler", () => {
  it("materialized: the empty summary, no handler call", async () => {
    const { query, handled } = await boot();
    for (const action of ["close", "closeRows", "closeStrict"]) {
      const res = await query(action, "status=nope");
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toEqual({ matched: 0, processed: 0, skipped: [], failed: [] });
    }
    expect(handled).toEqual([]);
  });

  it("streamed: the empty summary, no handler call", async () => {
    const { query, handled } = await boot();
    const res = await query("stream", "status=nope");
    expect(res.body).toEqual({ matched: 0, processed: 0, skipped: [], failed: [] });
    expect(handled).toEqual([]);
  });
});

describe("query targets — a streamed handler failing mid-run", () => {
  it("answers the partial summary with aborted; earlier batches stay counted", async () => {
    const { query, handled } = await boot({ failOnBatch: 1 });
    const res = await query("stream", "status=open");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // batches: [1,2] (2 failed by the handler), [4,5] (handler throws)
    expect(handled.map((h) => h.ids)).toEqual([
      [1, 2],
      [4, 5],
    ]);
    expect(res.body).toEqual({
      matched: 4,
      processed: 1,
      skipped: [],
      failed: [
        { id: { id: 2 }, reason: "locked" },
        { id: { id: 4 }, reason: "backend down" },
        { id: { id: 5 }, reason: "backend down" },
      ],
      aborted: { status: 503, message: "backend down" },
    });
  });

  it("a failure on the first batch: nothing processed, every row failed, aborted", async () => {
    const { query } = await boot({ failOnBatch: 0 });
    const res = await query("stream", "status=open");
    expect(res.body).toMatchObject({
      matched: 4,
      processed: 0,
      aborted: { status: 503, message: "backend down" },
    });
    expect(res.body.failed.map((f: any) => f.id.id).toSorted()).toEqual([1, 2, 4, 5]);
  });

  it("an error before any batch reached the handler stays an error", async () => {
    const { query } = await boot({
      scopeHook: () => {
        throw new HttpError(502, "scope down");
      },
    });
    expect((await query("stream", "status=open")).status).toBe(502);
  });
});

describe("query targets — phase-2 loads carry their own $limit", () => {
  it("a batch re-load never inherits a search pipeline's default limit", async () => {
    const { query, issues } = await boot();
    const spy = vi.spyOn(issues, "findMany");
    await query("stream", "status=open");
    const loads = spy.mock.calls
      .map((c) => (c[0] as { controls?: { $limit?: number; $sort?: unknown } }).controls)
      .filter((c) => c?.$sort === undefined);
    expect(loads.length).toBeGreaterThan(0);
    for (const c of loads) expect(c?.$limit).toBeGreaterThanOrEqual(2);
    spy.mockRestore();
  });
});
