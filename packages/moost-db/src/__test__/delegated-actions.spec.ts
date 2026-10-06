/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import type { FilterExpr, TMetaResponse } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { HttpError, MoostHttp, Post } from "@moostjs/event-http";
import { EventContext, cached, current, key, run } from "@wooksjs/event-core";
import { useBody } from "@wooksjs/http-body";
import {
  Inherit,
  Injectable,
  Intercept,
  Moost,
  TInterceptorPriority,
  defineBeforeInterceptor,
  getMoostInfact,
  useControllerContext,
} from "moost";

import { AsDbController } from "../as-db.controller";
import { AsDbReadableController } from "../as-db-readable.controller";
import type { TDbRequestContext } from "../as-readable.controller";
import { TableController, ViewController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { DbActionsFrom } from "../actions/db-actions-from.decorator";
import { DbActionTarget, type TDbActionTarget } from "../actions/target";
import { ActionDisabledError } from "../actions/action-disabled-error";
import { InputForm } from "../actions/db-action-input-form.decorator";
import { discoverDelegations, runAsController } from "../actions/delegation";
import { prepareFixtures } from "./test-utils";

/**
 * `@DbActionsFrom` (since 0.1.147): a view (or any readable controller)
 * lists its source controller's row actions — `/meta` entries with `owner` /
 * `idMap`, the source's verdicts in the view rows' `$actions`, the renamed
 * `GET /meta/actions`, and query targets run through the source's own
 * action route in batches (the source re-checks every batch).
 */

let fx: Record<string, any>;

const TICKETS = [
  { key: "T1", teamId: "a", status: "open" },
  { key: "T2", teamId: "b", status: "open" },
  { key: "T3", teamId: "a", status: "open" },
];
const ISSUES = [
  { id: 1, ticketKey: "T1", status: "open", title: "one" },
  { id: 2, ticketKey: "T2", status: "open", title: "two" },
  { id: 3, ticketKey: "T3", status: "closed", title: "three" },
  { id: 4, ticketKey: "T1", status: "open", title: "four" },
];
const BOARD = [
  { rowId: 10, issueId: 1, ticketKey: "T1", title: "one", teamId: "a" },
  { rowId: 11, issueId: 2, ticketKey: "T2", title: "two", teamId: "b" },
  { rowId: 12, issueId: 3, ticketKey: "T3", title: "three", teamId: "a" },
  { rowId: 13, ticketKey: "T1", title: "no issue", teamId: "a" },
  { rowId: 14, issueId: 4, ticketKey: "T1", title: "four", teamId: "a" },
];

const closedRows = (rows: Array<{ status?: string }>) =>
  rows.map((r) => (r.status === "closed" ? "already closed" : false));

interface TSourceOpts {
  /** prepareRequest endpoints the source refuses with 403. */
  deny?: readonly string[];
  /** The source's row overlay (transformOne). */
  rowScope?: FilterExpr;
  /** The source's actionRowScope for `close`. */
  closeScope?: FilterExpr;
  /** prepareRequest resolves a FOR_EVENT dependency (a request principal). */
  forEvent?: boolean;
  /** The close route's guard records the body ids it authorizes; refuses `guardDeny`. */
  guardSeen?: unknown[];
  guardDeny?: number;
  /** A guard ahead of the gate answers with a plain value instead of running the action. */
  replyInstead?: boolean;
  /** The close handler throws `ActionDisabledError` for this id (after it ran). */
  handlerRefuses?: number;
  /** The close handler throws a 500 for this id. */
  handlerFails?: number;
  /** Called by the close handler with its ids (after it ran). */
  onClose?: (ids: number[]) => Promise<void>;
  /** The close handler records how many DI scopes are live. */
  scopeSizes?: number[];
}

/** A per-request principal — `FOR_EVENT`, resolved by the source's prepareRequest. */
@Injectable("FOR_EVENT")
class RequestPrincipal {
  readonly id = Math.random();
}

const noPkWarnings = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((c) => String(c[0]).includes("has no primary key")).length;

const liveScopes = () =>
  (getMoostInfact() as unknown as { scopes: Map<string, unknown> }).scopes.size;

/** The close route's body guard (see TSourceOpts.guardSeen). */
function bodyGuard(opts: TSourceOpts) {
  return defineBeforeInterceptor(async (reply) => {
    if (opts.replyInstead) {
      reply({ handled: "elsewhere" });
      return;
    }
    if (!opts.guardSeen) return;
    const body = await useBody().parseBody<{ ids?: Array<{ id: number }> }>();
    opts.guardSeen.push(body.ids?.map((i) => i.id));
    for (const { id } of body.ids ?? []) {
      if (id === opts.guardDeny) {
        reply(new HttpError(403, `not owner of ${id}`));
        return;
      }
    }
  }, TInterceptorPriority.GUARD);
}

/** The `prepareRequest` endpoint the current (child) event of the board saw. */
const boardEndpointKey = key<string>("da.board.endpoint");
const boardEndpoint = () =>
  current().has(boardEndpointKey) ? current().get(boardEndpointKey) : undefined;

let SEQ = 0;

async function bootApp(...controllers: Function[]) {
  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(...controllers);
  await app.init();
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await http.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res) return { status: 404, body: undefined }; // no route at all
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  return { app, send };
}

async function space() {
  const db = createAdapter();
  await db.getTable(fx.FwTicket).insertMany(structuredClone(TICKETS) as never);
  const issues = db.getTable(fx.FwIssue);
  await issues.insertMany(structuredClone(ISSUES) as never);
  const board = db.getTable(fx.FwBoardRow);
  await board.insertMany(structuredClone(BOARD) as never);
  return { db, issues, board };
}

function defineSource(issues: unknown, prefix: string, opts: TSourceOpts, log: unknown[][]) {
  let constructed = 0;
  @TableController(issues as never, prefix)
  @Inherit()
  class IssueCtrl extends AsDbController {
    protected override init() {
      constructed++;
    }

    protected async prepareRequest(ctx: TDbRequestContext) {
      if (opts.deny?.includes(ctx.endpoint)) throw new HttpError(403, "no grant");
      if (opts.forEvent) await useControllerContext().instantiate(RequestPrincipal);
    }

    protected override transformOne(filter: FilterExpr): FilterExpr {
      return opts.rowScope ? ({ $and: [filter, opts.rowScope] } as FilterExpr) : filter;
    }

    protected override actionRowScope(action: string) {
      return action === "close" ? opts.closeScope : undefined;
    }

    @Post("actions/close")
    @DbAction("close", {
      label: "Close",
      requiredFields: ["status"],
      disabled: closedRows,
      queryTarget: { maxRows: 50, batchSize: 2 },
    })
    @Intercept(bodyGuard(opts))
    async close(@DbActionIDs() ids: Array<{ id: number }>) {
      log.push(ids.map((i) => i.id));
      opts.scopeSizes?.push(liveScopes());
      for (const { id } of ids) {
        if (id === opts.handlerRefuses) {
          throw new ActionDisabledError("close", undefined, [{ id }], ["busy"]);
        }
        if (id === opts.handlerFails) throw new HttpError(500, `cannot close ${id}`);
        await (this.table as any).updateOne({ id, status: "closed" });
      }
      await opts.onClose?.(ids.map((i) => i.id));
      return { closed: ids.length, message: `closed ${ids.length}` };
    }

    @Post("actions/comment")
    @DbAction("comment", { label: "Comment" })
    comment(@DbActionID() id: unknown, @InputForm(fx.CommentForm) input: unknown) {
      return { id, input };
    }

    @Post("actions/purge")
    @DbAction("purge", { label: "Purge" })
    purge() {
      return { ok: true };
    }
  }
  return { IssueCtrl, constructed: () => constructed };
}

async function boot(
  opts: TSourceOpts & {
    board?: {
      readScope?: FilterExpr;
      hideIssueId?: boolean;
      actions?: string[];
      /** The view's applyMetaOverlay prunes every action it sees. */
      pruneMeta?: boolean;
      /** The view's transformProjection drops `issueId`. */
      projectAwayIssueId?: boolean;
      /** The view hides its own identity (`rowId`). */
      hideRowId?: boolean;
      /** The view hides `path` for requests of this `prepareRequest` endpoint only. */
      hideAt?: { endpoint: string; path: string };
    };
  } = {},
) {
  getMoostInfact()._cleanup();
  const { issues, board } = await space();
  const n = ++SEQ;
  const log: unknown[][] = [];
  const { IssueCtrl, constructed } = defineSource(issues, `issues${n}`, opts, log);
  const b = opts.board ?? {};

  @TableController(board as never, `board${n}`)
  @DbActionsFrom(() => IssueCtrl, { idMap: { id: "issueId" }, actions: b.actions })
  @Inherit()
  class BoardCtrl extends AsDbReadableController {
    protected override prepareRequest(ctx: TDbRequestContext) {
      current().set(boardEndpointKey, ctx.endpoint);
    }

    protected override transformFilter(filter: FilterExpr): FilterExpr {
      return b.readScope ? ({ $and: [filter, b.readScope] } as FilterExpr) : filter;
    }

    protected override hasField(path: string): boolean {
      if (b.hideRowId && path === "rowId") return false;
      if (b.hideAt?.path === path && boardEndpoint() === b.hideAt.endpoint) return false;
      return (!b.hideIssueId || path !== "issueId") && super.hasField(path);
    }

    protected override transformProjection(projection?: any): any {
      if (!b.projectAwayIssueId) return projection;
      const list: string[] = Array.isArray(projection)
        ? projection
        : ["rowId", "ticketKey", "title", "teamId", "issueId"];
      return list.filter((f) => f !== "issueId");
    }

    protected override applyMetaOverlay(meta: TMetaResponse): TMetaResponse {
      return b.pruneMeta ? { ...meta, actions: [] } : meta;
    }

    @Post("actions/pin")
    @DbAction("pin", { label: "Pin" })
    pin(@DbActionID() id: unknown) {
      return { id };
    }
  }

  const { app, send } = await bootApp(IssueCtrl, BoardCtrl);
  const get = async (path: string): Promise<any> => {
    const res = await send("GET", path);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  return {
    app,
    send,
    get,
    log,
    issues,
    constructed,
    board: `/board${n}`,
    boardTable: board,
    source: `/issues${n}`,
    IssueCtrl,
    BoardCtrl,
  };
}

const actionsByRow = (rows: Array<Record<string, any>>) =>
  Object.fromEntries(rows.map((r) => [r.rowId, r.$actions]));

beforeAll(async () => {
  await prepareFixtures();
  fx = {
    ...(await import("./fixtures/fw3-actions.as")),
    ...(await import("./fixtures/input-form.as")),
  };
});

describe("@DbActionsFrom — /meta", () => {
  it("lists the source's row actions with owner, idMap, the source's form, no disabled", async () => {
    const { get, board, source } = await boot();
    const meta = await get(`${board}/meta`);
    const byName = Object.fromEntries(meta.actions.map((a: any) => [a.name, a]));
    expect(meta.actions.map((a: any) => a.name)).toEqual(["pin", "close", "comment"]);
    expect(byName.pin.owner).toBeUndefined();
    expect(byName.close).toEqual({
      name: "close",
      label: "Close",
      level: "rows",
      processor: "backend",
      value: `${source}/actions/close`,
      owner: source,
      idMap: { id: "issueId" },
      queryTarget: { maxRows: 50, url: `${board}/delegated-actions/close` },
    });
    expect(byName.comment).toMatchObject({
      inputForm: "CommentForm",
      formUrl: `${source}/meta/form/CommentForm`,
      owner: source,
    });
    expect((await get(byName.comment.formUrl)).type).toBeDefined();
  });

  it("a subset (`actions`) delegates only those", async () => {
    const { get, board } = await boot({ board: { actions: ["comment"] } });
    expect((await get(`${board}/meta`)).actions.map((a: any) => a.name)).toEqual([
      "pin",
      "comment",
    ]);
  });

  it("the source decides: a caller its prepareRequest refuses gets no delegated entries", async () => {
    const { get, board } = await boot({ deny: ["availableActions"] });
    expect((await get(`${board}/meta`)).actions.map((a: any) => a.name)).toEqual(["pin"]);
  });

  it("the view's applyMetaOverlay never sees (or prunes) delegated entries", async () => {
    const { get, board } = await boot({ board: { pruneMeta: true } });
    expect((await get(`${board}/meta`)).actions.map((a: any) => a.name)).toEqual([
      "close",
      "comment",
    ]);
    const rows = await get(`${board}/query?$actions=true&$sort=rowId`);
    expect(rows[0].$actions).toEqual(["close", "comment"]);
  });

  it("an id path the view hides drops the delegation", async () => {
    const { get, board } = await boot({ board: { hideIssueId: true } });
    expect((await get(`${board}/meta`)).actions.map((a: any) => a.name)).toEqual(["pin"]);
    const rows = await get(`${board}/query?$actions=true&$sort=rowId`);
    expect(rows[0].$actions).toEqual(["pin"]);
  });
});

describe("@DbActionsFrom — $actions on the view's rows", () => {
  it("each row carries the source's verdict for its source row; no source id → none", async () => {
    const { get, board, source } = await boot();
    const rows = await get(`${board}/query?$actions=true&$sort=rowId`);
    expect(actionsByRow(rows)).toEqual({
      10: ["pin", "close", "comment"],
      11: ["pin", "close", "comment"],
      12: ["pin", "comment"],
      13: ["pin"],
      14: ["pin", "close", "comment"],
    });
    expect(rows[2].$disabledReasons).toEqual({ close: "already closed" });
    // The same verdicts the source gives its own rows.
    const own = await get(`${source}/query?$actions=true&$sort=id`);
    expect(own.map((r: any) => r.$actions)).toEqual([
      ["close", "comment"],
      ["close", "comment"],
      ["comment"],
      ["close", "comment"],
    ]);
  });

  it("the id path is selected (and kept) even when $select omits it", async () => {
    const { get, board } = await boot();
    const rows = await get(`${board}/query?$actions=true&$sort=rowId&$select=title`);
    expect(rows[0]).toEqual({
      title: "one",
      rowId: 10,
      issueId: 1,
      $actions: ["pin", "close", "comment"],
    });
  });

  it("the source's row overlay and actionRowScope narrow the verdicts", async () => {
    const { get, board } = await boot({
      rowScope: { ticketKey: { $in: ["T1", "T3"] } } as FilterExpr,
      closeScope: { id: { $ne: 4 } } as FilterExpr,
    });
    const rows = await get(`${board}/pages?$actions=true&$sort=rowId&$size=10`);
    expect(actionsByRow(rows.data)).toEqual({
      10: ["pin", "close", "comment"],
      11: ["pin"],
      12: ["pin", "comment"],
      13: ["pin"],
      14: ["pin", "comment"],
    });
  });

  it("a caller the source refuses (403) gets the view's own actions only", async () => {
    const { get, board } = await boot({ deny: ["availableActions"] });
    const rows = await get(`${board}/query?$actions=true&$sort=rowId`);
    expect(rows.every((r: any) => r.$actions.join() === "pin")).toBe(true);
  });

  it("the source is the singleton moost bound (never constructed twice)", async () => {
    const { get, board, constructed } = await boot();
    await get(`${board}/query?$actions=true`);
    await get(`${board}/meta`);
    expect(constructed()).toBe(1);
  });
});

describe("@DbActionsFrom — GET /meta/actions", () => {
  it("answers delegated actions when the source id is derivable by renaming", async () => {
    const { get, board } = await boot();
    // `/:id` addresses the board's rowId — not the issue id: own actions only.
    expect(await get(`${board}/meta/actions/12`)).toEqual({ actions: ["pin"] });
    // `?issueId=` renames to the source id (the board has no such identification).
    expect(await get(`${board}/meta/actions?issueId=3`)).toEqual({
      actions: ["comment"],
      disabledReasons: { close: "already closed" },
    });
    expect(await get(`${board}/meta/actions?issueId=1`)).toEqual({ actions: ["close", "comment"] });
    expect((await get(`${board}/meta/actions?rowId=10`)).actions).toEqual(["pin"]);
  });
});

describe("@DbActionsFrom — query targets (delegated)", () => {
  it("resolves the view's rows, maps them to source ids and runs the source's route in batches", async () => {
    const { send, board, log, issues } = await boot();
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "teamId=a" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // issue 3 is closed: the source's gate refuses it, the batch reruns without it
    expect(log).toEqual([[1], [4]]);
    expect(res.body).toEqual({
      matched: 4,
      processed: 2,
      skipped: [
        { id: { rowId: 13 }, reason: "unmapped" },
        { id: { id: 3 }, reason: "already closed" },
      ],
      failed: [],
      messages: ["closed 1", "closed 1"],
      message: "closed 1",
    });
    expect(((await issues.findOne({ filter: { id: 1 } } as never)) as any)?.status).toBe("closed");
    expect(((await issues.findOne({ filter: { id: 2 } } as never)) as any)?.status).toBe("open");
  });

  it("dryRun counts the view rows; expectCount mismatch → 409; nothing runs", async () => {
    const { send, board, log } = await boot();
    const url = `${board}/delegated-actions/close`;
    expect((await send("POST", url, { query: { q: "teamId=a", dryRun: true } })).body).toEqual({
      matched: 4,
    });
    const changed = await send("POST", url, { query: { q: "teamId=a", expectCount: 3 } });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: "TARGET_CHANGED", matched: 4 });
    expect(log).toEqual([]);
  });

  it("exclusions use the view's identifications or the id paths", async () => {
    const { send, board, log } = await boot();
    const url = `${board}/delegated-actions/close`;
    await send("POST", url, { query: { q: "teamId=a", exclude: [{ rowId: 10 }] } });
    expect(log).toEqual([[4]]);
    log.length = 0;
    await send("POST", url, { query: { q: "teamId=a", exclude: [{ issueId: 4 }] } });
    expect(log).toEqual([[1]]);
    const bad = await send("POST", url, { query: { q: "", exclude: [{ title: "x" }] } });
    expect(bad.status).toBe(400);
  });

  it("the view's read scope bounds the target", async () => {
    const { send, board, log } = await boot({
      board: { readScope: { teamId: "b" } as FilterExpr },
    });
    const res = await send("POST", `${board}/delegated-actions/close`, { query: { q: "" } });
    expect(res.body.matched).toBe(1);
    expect(log).toEqual([[2]]);
  });

  it("SECURITY: a reader of the view without the source's action grant runs nothing", async () => {
    const { send, board, log, issues } = await boot({ deny: ["action"] });
    const res = await send("POST", `${board}/delegated-actions/close`, { query: { q: "" } });
    expect(res.status).toBe(403);
    expect(log).toEqual([]);
    expect(((await issues.findOne({ filter: { id: 1 } } as never)) as any)?.status).toBe("open");
  });

  it("SECURITY: view rows mapping outside the source's scope are skipped, never run", async () => {
    const { send, board, log } = await boot({
      rowScope: { ticketKey: "T1" } as FilterExpr,
      closeScope: { id: { $ne: 4 } } as FilterExpr,
    });
    const res = await send("POST", `${board}/delegated-actions/close`, { query: { q: "" } });
    expect(log).toEqual([[1]]);
    expect(res.body.processed).toBe(1);
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([{ id: { id: 2 } }, { id: { id: 3 } }, { id: { id: 4 } }]),
    );
  });

  it("only delegated actions declaring queryTarget take one; ids are refused here", async () => {
    const { send, board } = await boot();
    const comment = await send("POST", `${board}/delegated-actions/comment`, { query: { q: "" } });
    expect(comment.status).toBe(400);
    expect(comment.body.code).toBe("TARGET_INVALID");
    expect(
      (await send("POST", `${board}/delegated-actions/nope`, { query: { q: "" } })).status,
    ).toBe(404);
    const ids = await send("POST", `${board}/delegated-actions/close`, { ids: [{ id: 1 }] });
    expect(ids.body.code).toBe("TARGET_INVALID");
  });
});

describe("@DbActionsFrom — query targets: $search by the READ's visibility", () => {
  it("a title hidden on the read refuses $search (400 TARGET_INVALID), whatever the route sees", async () => {
    const { send, board, log } = await boot({
      board: { hideAt: { endpoint: "query", path: "title" } },
    });
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "$search=one", dryRun: true },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "TARGET_INVALID", action: "close" });
    expect(log).toEqual([]);
  });

  it("a title hidden on the route only never drops the term (matches nothing, not everything)", async () => {
    const { send, board } = await boot({
      board: { hideAt: { endpoint: "delegatedAction", path: "title" } },
    });
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "$search=zzz", dryRun: true },
    });
    expect(res.body).toEqual({ matched: 0 });
    const hit = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "$search=three", dryRun: true },
    });
    expect(hit.body).toEqual({ matched: 1 });
  });

  it("'unmapped' skipped ids list the identity fields the READ shows", async () => {
    const { send, board } = await boot({
      board: { hideAt: { endpoint: "query", path: "rowId" } },
    });
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "teamId=a" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.skipped).toEqual(expect.arrayContaining([{ id: {}, reason: "unmapped" }]));
  });
});

describe("@DbActionsFrom — query targets onto a @DbActionTarget source, many batches", () => {
  it("collects the source target's summary per batch; no listener-leak warning", async () => {
    getMoostInfact()._cleanup();
    const { issues, board } = await space();
    const extra = Array.from({ length: 24 }, (_, i) => i + 100);
    await issues.insertMany(
      extra.map((id) => ({
        id,
        ticketKey: "T2",
        status: id % 5 === 0 ? "closed" : "open",
        title: "x",
      })) as never,
    );
    await board.insertMany(
      extra.map((id) => ({
        rowId: id,
        issueId: id,
        ticketKey: "T2",
        title: "x",
        teamId: "b",
      })) as never,
    );
    const n = ++SEQ;
    const seen: number[][] = [];
    @TableController(issues as never, `sissues${n}`)
    class StreamSource extends AsDbController {
      @Post("actions/touch")
      @DbAction("touch", {
        label: "Touch",
        requiredFields: ["status"],
        disabled: closedRows,
        queryTarget: { batchSize: 2 },
      })
      async touch(@DbActionTarget() target: TDbActionTarget<{ id: number }>) {
        for await (const { rows } of target.batches()) {
          seen.push(rows.map((r) => r.id));
          if (rows.some((r) => r.id === 101)) target.fail({ id: 101 }, "busy");
        }
        return target.summary();
      }
    }
    @TableController(board as never, `sboard${n}`)
    @DbActionsFrom(() => StreamSource, { idMap: { id: "issueId" } })
    class StreamBoard extends AsDbReadableController {}
    const { send } = await bootApp(StreamSource, StreamBoard);
    const warn = vi.spyOn(process, "emitWarning");
    const res = await send("POST", `/sboard${n}/delegated-actions/touch`, {
      query: { q: "teamId=b" },
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(seen.flat()).toEqual([2, ...extra.filter((id) => id % 5 !== 0)]);
    expect(res.body).toMatchObject({
      matched: 25,
      processed: 1 + extra.filter((id) => id % 5 !== 0).length - 1,
      failed: [{ id: { id: 101 }, reason: "busy" }],
    });
    expect(res.body.skipped).toEqual(
      extra.filter((id) => id % 5 === 0).map((id) => ({ id: { id }, reason: "already closed" })),
    );
  });
});

describe("@DbActionsFrom — over a real view (derived idMap)", () => {
  it("derives id ← IssueBoard.id; $actions follow the source", async () => {
    getMoostInfact()._cleanup();
    const { db, issues } = await space();
    const n = ++SEQ;
    const { IssueCtrl } = defineSource(issues, `vissues${n}`, {}, []);
    const view = db.getView(fx.FwIssueBoard);
    vi.spyOn(view, "findMany").mockImplementation(
      async () =>
        ISSUES.map((i) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          teamId: TICKETS.find((t) => t.key === i.ticketKey)!.teamId,
        })) as never,
    );
    @ViewController(view as never, `vboard${n}`)
    @DbActionsFrom(() => IssueCtrl)
    class ViewCtrl extends AsDbReadableController {}
    const { app, send } = await bootApp(IssueCtrl, ViewCtrl);
    const rows = (await send("GET", `/vboard${n}/query?$actions=true`)).body;
    expect(rows.map((r: any) => r.$actions)).toEqual([
      ["close", "comment"],
      ["close", "comment"],
      ["comment"],
      ["close", "comment"],
    ]);
    const meta = (await send("GET", `/vboard${n}/meta`)).body;
    const close = meta.actions.find((a: any) => a.name === "close");
    const delegations = await withEvent(app, ViewCtrl, view);
    expect(delegations[0].idMap).toEqual({ id: "id" });
    // The view has no identity of its own: the id map is on the wire.
    expect(view.preferredId).toEqual([]);
    expect(close.idMap).toEqual({ id: "id" });
    // …and `/meta/actions?id=` renames to the source id.
    expect((await send("GET", `/vboard${n}/meta/actions?id=3`)).body).toEqual({
      actions: ["comment"],
      disabledReasons: { close: "already closed" },
    });
  });
});

/** Runs discovery for a view-like controller inside a synthetic event. */
async function withEvent(app: Moost, ctor: Function, readable: any) {
  const ctx = new EventContext({ logger: console as never });
  return run(ctx, () =>
    discoverDelegations({
      ctor,
      readable,
      app,
      logger: console as never,
      instantiate: async (c) => getMoostInfact().get(c as never),
    }),
  );
}

describe("@DbActionsFrom — configuration errors", () => {
  async function discover(
    meta: { idMap?: Record<string, string>; actions?: string[] },
    viewType?: any,
  ) {
    getMoostInfact()._cleanup();
    const { db, issues, board } = await space();
    const n = ++SEQ;
    const { IssueCtrl } = defineSource(issues, `eissues${n}`, {}, []);
    const readable = viewType ? db.getView(viewType) : board;
    @TableController(readable as never, `eboard${n}`)
    @DbActionsFrom(() => IssueCtrl, meta)
    class Ctrl extends AsDbReadableController {
      @Post("actions/close")
      @DbAction("close2", { label: "x" })
      close2(@DbActionID() id: unknown) {
        return id;
      }
    }
    const { app } = await bootApp(IssueCtrl, Ctrl);
    return withEvent(app, Ctrl, readable);
  }

  it("unknown action, table-level action, idMap not an identification, unknown path", async () => {
    await expect(discover({ idMap: { id: "issueId" }, actions: ["nope"] })).rejects.toThrow(
      /has no action "nope"/,
    );
    await expect(discover({ idMap: { id: "issueId" }, actions: ["purge"] })).rejects.toThrow(
      /table-level action/,
    );
    await expect(discover({ idMap: { status: "issueId" } })).rejects.toThrow(
      /not an identification/,
    );
    await expect(discover({ idMap: { id: "nope" } })).rejects.toThrow(/no such field/);
  });

  it("a non-view needs idMap; a view whose id is missing / ambiguous / aggregated refuses", async () => {
    await expect(discover({})).rejects.toThrow(/not a view — pass an explicit idMap/);
    await expect(discover({}, fx.FwIssueBoardTwice)).rejects.toThrow(/several columns map it/);
    await expect(discover({}, fx.FwTeamCounts)).rejects.toThrow(/no plain column maps it/);
    const renamed = await discover({}, fx.FwIssueBoardRenamed);
    expect(renamed[0].idMap).toEqual({ id: "issueId" });
  });

  it("a name colliding with the controller's own action, and an unregistered source", async () => {
    getMoostInfact()._cleanup();
    const { issues, board } = await space();
    const n = ++SEQ;
    const { IssueCtrl } = defineSource(issues, `cissues${n}`, {}, []);
    @TableController(board as never, `cboard${n}`)
    @DbActionsFrom(() => IssueCtrl, { idMap: { id: "issueId" } })
    class Colliding extends AsDbReadableController {
      @Post("actions/close")
      @DbAction("close", { label: "own close" })
      close(@DbActionID() id: unknown) {
        return id;
      }
    }
    const { app } = await bootApp(IssueCtrl, Colliding);
    await expect(withEvent(app, Colliding, board)).rejects.toThrow(/collides with Colliding/);

    @TableController(board as never, `uboard${n}`)
    @DbActionsFrom(() => IssueCtrl, { idMap: { id: "issueId" } })
    class Orphan extends AsDbReadableController {}
    const { app: app2 } = await bootApp(Orphan);
    await expect(withEvent(app2, Orphan, board)).rejects.toThrow(/not a controller registered/);
  });
});

describe("runAsController — write isolation", () => {
  it("child writes and cached slots stay in the child; reads fall through", async () => {
    const parentKey = key<string>("parent");
    const childOnly = cached(() => ({}));
    const parent = new EventContext({ logger: console as never });
    parent.set(parentKey, "view");
    await run(parent, async () => {
      const seen = await runAsController({}, "m", async () => {
        const ctx = current();
        const before = ctx.get(parentKey);
        ctx.set(parentKey, "source");
        return { before, after: ctx.get(parentKey), cachedValue: ctx.get(childOnly) };
      });
      expect(seen.before).toBe("view");
      expect(seen.after).toBe("source");
      expect(parent.get(parentKey)).toBe("view");
      expect(parent.hasOwn(childOnly)).toBe(false);
    });
  });
});

describe("@DbActionsFrom — the source runs as itself (regressions)", () => {
  it("H1: a FOR_EVENT dependency of the source resolves on the view's /meta, reads and /meta/actions", async () => {
    const { get, send, board, log } = await boot({ forEvent: true });
    const meta = await get(`${board}/meta`);
    expect(meta.actions.map((a: any) => a.name)).toEqual(["pin", "close", "comment"]);
    const rows = await get(`${board}/query?$actions=true&$sort=rowId`);
    expect(rows[0].$actions).toEqual(["pin", "close", "comment"]);
    expect(await get(`${board}/meta/actions?issueId=1`)).toEqual({ actions: ["close", "comment"] });
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "teamId=a" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(log).toEqual([[1], [4]]);
  });

  it("H2: the source's body readers (a guard via useBody) see each batch's ids, never the view's body", async () => {
    const guardSeen: unknown[] = [];
    const { send, board, log } = await boot({ guardSeen, guardDeny: 4 });
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "teamId=a" },
    });
    // batches [1,3] → the gate refuses 3 (closed) → rerun [1]; then [4] → the guard refuses it
    expect(guardSeen).toEqual([[1, 3], [1], [4]]);
    expect(log).toEqual([[1]]);
    expect(res.body).toMatchObject({
      processed: 1,
      failed: [{ id: { id: 4 }, reason: "not owner of 4" }],
      aborted: { status: 403, message: "not owner of 4" },
    });
  });

  it("M1: an ActionDisabledError thrown by the HANDLER is never retried (no double side effects)", async () => {
    const { send, board, log } = await boot({ handlerRefuses: 4 });
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "teamId=a" },
    });
    // [1,3] → gate refuses 3 → [1] ran; [4] ran and threw: not rerun
    expect(log).toEqual([[1], [4]]);
    expect(res.body).toMatchObject({
      processed: 1,
      failed: [{ id: { id: 4 }, reason: expect.any(String) }],
      aborted: { status: 409 },
    });
  });

  it("M2: a batch an interceptor answered for is 'not run', never counted as processed", async () => {
    const { send, board, log } = await boot({ replyInstead: true });
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "teamId=a" },
    });
    expect(log).toEqual([]);
    expect(res.body.processed).toBe(0);
    expect(res.body.failed.map((f: any) => [f.id.id, f.reason])).toEqual([
      [1, "not run"],
      [3, "not run"],
      [4, "not run"],
    ]);
  });

  it("M3: a source row whose view rows left the query before its batch ran is skipped as stale", async () => {
    const tables: { board?: any } = {};
    const { send, board, log, boardTable } = await boot({
      onClose: async (ids) => {
        if (ids.includes(1)) await tables.board.updateOne({ rowId: 14, teamId: "z" });
      },
    });
    tables.board = boardTable;
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "teamId=a" },
    });
    expect(log).toEqual([[1]]);
    expect(res.body.skipped).toEqual(expect.arrayContaining([{ id: { id: 4 }, reason: "stale" }]));
    expect(res.body.processed).toBe(1);
  });
});

describe("@DbActionsFrom — delegated runs: failures, exclusions, visibility (regressions)", () => {
  it("M4: a batch failing after an earlier one ran → the partial summary with aborted", async () => {
    const { send, board, log, issues } = await boot({ handlerFails: 4 });
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "teamId=a" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(log).toEqual([[1], [4]]);
    expect(res.body).toMatchObject({
      matched: 4,
      processed: 1,
      failed: [{ id: { id: 4 }, reason: "cannot close 4" }],
      aborted: { status: 500, message: "cannot close 4" },
    });
    // the first batch stays applied
    expect(((await issues.findOne({ filter: { id: 1 } } as never)) as any)?.status).toBe("closed");
  });

  it("M4: a failure before anything ran stays the request's error", async () => {
    const { send, board, log } = await boot({ handlerFails: 1 });
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "teamId=a" },
    });
    // the handler ran on [1] and threw — uncertain, so the summary reports it
    expect(log).toEqual([[1]]);
    expect(res.body.aborted).toEqual({ status: 500, message: "cannot close 1" });
    const denied = await boot({ deny: ["action"] });
    expect(
      (await denied.send("POST", `${denied.board}/delegated-actions/close`, { query: { q: "" } }))
        .status,
    ).toBe(403);
  });

  it("C: the source handler's message reaches the summary (per batch + joined)", async () => {
    const { send, board } = await boot();
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "teamId=a" },
    });
    expect(res.body.messages).toEqual(["closed 1", "closed 1"]);
    expect(res.body.message).toBe("closed 1");
  });

  it("M8: excluding a view row leaves its source row out even when another view row maps to it", async () => {
    const { send, board, log, boardTable } = await boot();
    await boardTable.insertOne({
      rowId: 15,
      issueId: 1,
      ticketKey: "T1",
      title: "dup",
      teamId: "a",
    });
    await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "teamId=a", exclude: [{ rowId: 10 }] },
    });
    expect(log.flat()).not.toContain(1);
    expect(log).toEqual([[4]]);
  });

  it("L3: a delegation whose id path transformProjection drops is inactive", async () => {
    const { get, board } = await boot({ board: { projectAwayIssueId: true } });
    expect((await get(`${board}/meta`)).actions.map((a: any) => a.name)).toEqual(["pin"]);
    const rows = await get(`${board}/query?$actions=true&$sort=rowId&$select=title`);
    expect(rows[0]).not.toHaveProperty("issueId");
    expect(rows[0].$actions).toEqual(["pin"]);
  });

  it("L4: an 'unmapped' entry never echoes a view identity the caller can't see", async () => {
    const { send, board } = await boot({ board: { hideRowId: true } });
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "teamId=a" },
    });
    expect(res.body.skipped).toEqual(expect.arrayContaining([{ id: {}, reason: "unmapped" }]));
    expect(JSON.stringify(res.body)).not.toContain("rowId");
  });

  it("L10: a dry run is refused when the source doesn't list the action for the caller", async () => {
    const { send, board, log } = await boot({ deny: ["availableActions"] });
    const res = await send("POST", `${board}/delegated-actions/close`, {
      query: { q: "teamId=a", dryRun: true },
    });
    expect(res.status).toBe(403);
    expect(log).toEqual([]);
  });

  it("L13: each batch's DI scope is released when its handler settles (no pile-up)", async () => {
    const scopeSizes: number[] = [];
    const { send, board } = await boot({ scopeSizes });
    const before = liveScopes();
    await send("POST", `${board}/delegated-actions/close`, { query: { q: "teamId=a" } });
    expect(scopeSizes).toHaveLength(2);
    expect(scopeSizes[1]).toBe(scopeSizes[0]);
    await vi.waitFor(() => expect(liveScopes()).toBe(before));
  });
});

describe("@DbActionsFrom — the delegated route and discovery (regressions)", () => {
  it("D: only a controller declaring @DbActionsFrom (and its subclasses) gets the route", async () => {
    getMoostInfact()._cleanup();
    const { issues, board } = await space();
    const n = ++SEQ;
    const { IssueCtrl } = defineSource(issues, `rissues${n}`, {}, []);
    @TableController(board as never, `rboard${n}`)
    @DbActionsFrom(() => IssueCtrl, { idMap: { id: "issueId" } })
    class Delegating extends AsDbReadableController {}
    @TableController(board as never, `rsub${n}`)
    class SubDelegating extends Delegating {}
    @TableController(board as never, `rplain${n}`)
    class Plain extends AsDbReadableController {
      protected prepareRequest(): void {
        throw new HttpError(500, "prepareRequest must not run");
      }
    }
    const { send } = await bootApp(IssueCtrl, Delegating, SubDelegating, Plain);
    const body = { query: { q: "", dryRun: true } };
    expect((await send("POST", `/rboard${n}/delegated-actions/close`, body)).body).toEqual({
      matched: 5,
    });
    expect((await send("POST", `/rsub${n}/delegated-actions/close`, body)).body).toEqual({
      matched: 5,
    });
    expect((await send("POST", `/rplain${n}/delegated-actions/close`, body)).status).toBe(404);
    expect((await send("POST", `/rissues${n}/delegated-actions/close`, body)).status).toBe(404);
  });

  it("M7: a parameterized source route never advertises a delegated query target", async () => {
    getMoostInfact()._cleanup();
    const { issues, board } = await space();
    const n = ++SEQ;
    @TableController(issues as never, `pissues${n}`)
    class ParamSource extends AsDbController {
      @Post("actions/:tenant/close")
      @DbAction("close", { label: "Close", queryTarget: true })
      close(@DbActionIDs() ids: unknown) {
        return { ids };
      }
    }
    @TableController(board as never, `pboard${n}`)
    @DbActionsFrom(() => ParamSource, { idMap: { id: "issueId" } })
    class ParamBoard extends AsDbReadableController {}
    const { send } = await bootApp(ParamSource, ParamBoard);
    const meta = (await send("GET", `/pboard${n}/meta`)).body;
    expect(meta.actions.find((a: any) => a.name === "close").queryTarget).toBeUndefined();
    const res = await send("POST", `/pboard${n}/delegated-actions/close`, { query: { q: "" } });
    expect(res.status).toBe(400);
  });

  it("L7 / stale app: a re-booted app's delegated batches run through ITS router; failures aren't memoized", async () => {
    getMoostInfact()._cleanup();
    const { issues, board } = await space();
    const n = ++SEQ;
    const log: unknown[][] = [];
    const { IssueCtrl } = defineSource(issues, `aissues${n}`, {}, log);
    @TableController(board as never, `aboard${n}`)
    @DbActionsFrom(() => IssueCtrl, { idMap: { id: "issueId" } })
    class AppBoard extends AsDbReadableController {}
    // app 1 boots WITHOUT the source: discovery fails (and must not stick)
    const first = await bootApp(AppBoard);
    expect((await first.send("GET", `/aboard${n}/meta`)).status).toBe(500);
    // app 2 (same singletons) — with the source and a global interceptor of its own
    const seen: string[] = [];
    const app2 = new Moost();
    const http2 = new MoostHttp();
    app2.adapter(http2);
    app2.applyGlobalInterceptors(
      defineBeforeInterceptor(() => {
        seen.push(useControllerContext().getMethod() ?? "");
      }),
    );
    app2.registerControllers(IssueCtrl, AppBoard);
    await app2.init();
    const res = await http2.request(`/aboard${n}/delegated-actions/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: { q: "teamId=a" } }),
    });
    expect(res!.status).toBe(201);
    expect(log).toEqual([[1], [4]]);
    // app 2's global interceptor saw every batch (its router ran them)
    expect(seen.filter((m) => m === "close").length).toBeGreaterThanOrEqual(2);
  });

  it("item 1: no 'no primary key' warning for a scoped controller without own row actions", async () => {
    getMoostInfact()._cleanup();
    const db = createAdapter();
    const view = db.getView(fx.FwIssueBoard);
    vi.spyOn(view, "findMany").mockResolvedValue([] as never);
    const n = ++SEQ;
    @ViewController(view as never, `wview${n}`)
    class ScopedView extends AsDbReadableController {
      protected override actionRowScope() {
        return { id: 1 } as FilterExpr;
      }
    }
    @ViewController(view as never, `wviewact${n}`)
    class ScopedViewWithAction extends AsDbReadableController {
      protected override actionRowScope() {
        return { id: 1 } as FilterExpr;
      }

      @Post("actions/pin")
      @DbAction("pin", { label: "Pin" })
      pin(@DbActionID() id: unknown) {
        return { id };
      }
    }
    const { send } = await bootApp(ScopedView, ScopedViewWithAction);
    const infact = getMoostInfact() as any;
    const quiet = vi.spyOn((await infact.get(ScopedView)).logger, "warn");
    const loud = vi.spyOn((await infact.get(ScopedViewWithAction)).logger, "warn");
    await send("GET", `/wview${n}/query?$actions=true`);
    await send("GET", `/wviewact${n}/query?$actions=true`);
    await send("GET", `/wviewact${n}/query?$actions=true`);
    expect(noPkWarnings(quiet)).toBe(0);
    expect(noPkWarnings(loud)).toBe(1);
  });

  it("E: the controller-class checks hold for a class of another moost-db copy (symbol brand)", async () => {
    const { isAsDbReadableControllerSubclass, isAsValueHelpControllerSubclass } =
      await import("../actions/controller-registry");
    class Foreign {}
    Object.defineProperty(Foreign, Symbol.for("atscript-db.AsDbReadableController"), {
      value: true,
    });
    class ForeignChild extends Foreign {}
    expect(isAsDbReadableControllerSubclass(ForeignChild)).toBe(true);
    expect(isAsDbReadableControllerSubclass(class {})).toBe(false);
    expect(isAsValueHelpControllerSubclass(ForeignChild)).toBe(false);
  });
});

interface TLabelOpts {
  /** An interceptor after the gate (INTERCEPTOR priority) refuses with 418. */
  lateRefusal?: boolean;
  /** The handler throws a 500 once it reaches this id. */
  handlerFails?: number;
}

/**
 * A source whose `'rows'` actions validate an `@InputForm` (the gate runs —
 * and builds the target — BEFORE the form is validated) and a board
 * delegating them.
 */
async function bootLabels(opts: TLabelOpts = {}) {
  getMoostInfact()._cleanup();
  const { issues, board } = await space();
  const n = ++SEQ;
  const log: unknown[][] = [];
  const late = defineBeforeInterceptor(() => {
    if (opts.lateRefusal) throw new HttpError(418, "late refusal");
  }, TInterceptorPriority.INTERCEPTOR);

  @TableController(issues as never, `lissues${n}`)
  class LabelSource extends AsDbController {
    @Post("actions/label")
    @DbAction("label", { label: "Label", queryTarget: { batchSize: 2 } })
    @Intercept(late)
    async label(
      @DbActionIDs() ids: Array<{ id: number }>,
      @InputForm(fx.CommentForm) input: { note: string },
    ) {
      log.push(ids.map((i) => i.id));
      for (const { id } of ids) {
        if (id === opts.handlerFails) throw new HttpError(500, `cannot label ${id}`);
        await (this.table as any).updateOne({ id, title: input.note });
      }
      return { labeled: ids.length };
    }

    @Post("actions/labelStream")
    @DbAction("labelStream", { label: "Label (streamed)", queryTarget: { batchSize: 2 } })
    @Intercept(late)
    async labelStream(
      @DbActionTarget() target: TDbActionTarget<{ id: number }>,
      @InputForm(fx.CommentForm) input: { note: string },
    ) {
      for await (const { ids } of target.batches()) {
        log.push(ids.map((i) => i.id));
        for (const { id } of ids) {
          if (id === opts.handlerFails) throw new HttpError(500, `cannot label ${String(id)}`);
          await (this.table as any).updateOne({ id, title: input.note });
        }
      }
      return target.summary();
    }
  }

  @TableController(board as never, `lboard${n}`)
  @DbActionsFrom(() => LabelSource, { idMap: { id: "issueId" } })
  class LabelBoard extends AsDbReadableController {}

  const { send } = await bootApp(LabelSource, LabelBoard);
  const titles = async () =>
    ((await issues.findMany({ filter: {}, controls: { $sort: { id: 1 } } } as never)) as any[]).map(
      (r) => r.title,
    );
  return { send, log, titles, board: `/lboard${n}`, source: `/lissues${n}` };
}

describe("query targets — a batch counts as run only once its handler started (regressions)", () => {
  const ORIGINAL = ISSUES.map((i) => i.title);

  for (const action of ["label", "labelStream"]) {
    it(`delegated ${action}: an invalid input is the request's 400 — nothing ran`, async () => {
      const { send, log, titles, board, source } = await bootLabels();
      const url = `${board}/delegated-actions/${action}`;
      const direct = await send("POST", `${source}/actions/${action}`, {
        ids: [{ id: 1 }],
        input: { note: 7 },
      });
      expect(direct.status).toBe(400);
      for (const input of [{ note: 7 }, undefined]) {
        const res = await send("POST", url, { query: { q: "teamId=a" }, input });
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body).not.toHaveProperty("aborted");
        expect(res.body.errors).toEqual([expect.objectContaining({ path: "note" })]);
        if (input) expect(res.body).toEqual(direct.body);
      }
      expect(log).toEqual([]);
      expect(await titles()).toEqual(ORIGINAL);
    });

    it(`delegated ${action}: an interceptor after the gate refusing is the request's error`, async () => {
      const { send, log, board } = await bootLabels({ lateRefusal: true });
      const res = await send("POST", `${board}/delegated-actions/${action}`, {
        query: { q: "teamId=a" },
        input: { note: "x" },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(418);
      expect(log).toEqual([]);
    });

    it(`delegated ${action}: a failure after a handler started → the partial summary`, async () => {
      const { send, log, titles, board } = await bootLabels({ handlerFails: 4 });
      const res = await send("POST", `${board}/delegated-actions/${action}`, {
        query: { q: "teamId=a" },
        input: { note: "x" },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      // batches [1, 3] then [4] — the second batch's handler throws
      expect(log).toEqual([[1, 3], [4]]);
      expect(res.body).toMatchObject({
        matched: 4,
        processed: 2,
        failed: [{ id: { id: 4 }, reason: "cannot label 4" }],
        aborted: { status: 500, message: "cannot label 4" },
      });
      expect(await titles()).toEqual(["x", "two", "x", "four"]);
    });

    it(`own ${action}: an invalid input on a query target is the request's 400`, async () => {
      const { send, log, titles, source } = await bootLabels();
      const res = await send("POST", `${source}/actions/${action}`, {
        query: { q: "" },
        input: { note: 7 },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body).not.toHaveProperty("aborted");
      expect(res.body.errors).toEqual([expect.objectContaining({ path: "note" })]);
      expect(log).toEqual([]);
      expect(await titles()).toEqual(ORIGINAL);
    });
  }

  it("own labelStream: a failure after the handler received a batch → the partial summary", async () => {
    const { send, log, source } = await bootLabels({ handlerFails: 3 });
    const res = await send("POST", `${source}/actions/labelStream`, {
      query: { q: "" },
      input: { note: "x" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(log).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(res.body).toMatchObject({
      matched: 4,
      processed: 2,
      aborted: { status: 500, message: "cannot label 3" },
    });
  });
});

describe("@DbActionsFrom — the view's read overlay", () => {
  it("is conjoined once: the default queryTargetScope adds nothing over transformFilter(q)", async () => {
    getMoostInfact()._cleanup();
    const { issues, board } = await space();
    const n = ++SEQ;
    const { IssueCtrl } = defineSource(issues, `tissues${n}`, {}, []);
    const seen: FilterExpr[] = [];
    @TableController(board as never, `tboard${n}`)
    @DbActionsFrom(() => IssueCtrl, { idMap: { id: "issueId" } })
    class Scoped extends AsDbReadableController {
      protected override transformFilter(filter: FilterExpr): FilterExpr {
        seen.push(filter);
        return { $and: [filter, { teamId: "a" }] } as FilterExpr;
      }
    }
    const { send } = await bootApp(IssueCtrl, Scoped);
    const res = await send("POST", `/tboard${n}/delegated-actions/close`, {
      query: { q: "title!=two", dryRun: true },
    });
    expect(res.body).toEqual({ matched: 4 });
    expect(seen).toEqual([{ title: { $ne: "two" } }]);
  });
});

describe("@DbActionsFrom — several sources", () => {
  it("lists the delegations in declaration order (the top decorator first)", async () => {
    getMoostInfact()._cleanup();
    const { issues, board } = await space();
    const n = ++SEQ;
    const { IssueCtrl: First } = defineSource(issues, `oissues${n}`, {}, []);
    const { IssueCtrl: Second } = defineSource(issues, `oissuesb${n}`, {}, []);
    @TableController(board as never, `oboard${n}`)
    @DbActionsFrom(() => First, { idMap: { id: "issueId" }, actions: ["comment"] })
    @DbActionsFrom(() => Second, { idMap: { id: "issueId" }, actions: ["close"] })
    class TwoSources extends AsDbReadableController {}
    const { send } = await bootApp(First, Second, TwoSources);
    const meta = (await send("GET", `/oboard${n}/meta`)).body;
    expect(meta.actions.map((a: any) => [a.name, a.owner])).toEqual([
      ["comment", `/oissues${n}`],
      ["close", `/oissuesb${n}`],
    ]);
  });
});

describe("mapToSourceIds", () => {
  it("reads dot paths nested or as flat dotted keys (flat first); dedupes; -1 when unmapped", async () => {
    const { mapToSourceIds } = await import("../actions/delegation");
    const { ids, index } = mapToSourceIds(
      [{ "org.id": "a", n: 1 }, { org: { id: "a" }, n: 1 }, { org: { id: "b" } }, { n: 2 }],
      { tenant: "org.id", number: "n" },
    );
    expect(ids).toEqual([{ tenant: "a", number: 1 }]);
    expect(index).toEqual([0, 0, -1, -1]);
  });
});
