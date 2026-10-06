/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import type { FilterExpr, TDbRemoveGuardContext } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { HttpError, Post } from "@moostjs/event-http";
import { Inherit, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { AsDbReadableController } from "../as-db-readable.controller";
import { AsValueHelpController } from "../as-value-help.controller";
import type { TDbRequestContext } from "../as-readable.controller";
import { TableController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { DbActionRow, DbActionRows } from "../actions/db-action-row.decorator";
import { DbActionsFrom } from "../actions/db-actions-from.decorator";
import { DbActionTarget, type TDbActionTarget } from "../actions/target";
import type { TDbRowIdInput, TDbRowIdsContext } from "../actions/types";
import { bootHttp, prepareFixtures } from "./test-utils";

/**
 * `resolveRowIds(ids, ctx)` (since 0.1.148): one hook that maps stale / alias
 * ids to the row's current id on every id-addressed endpoint — `/one`,
 * `DELETE`, `/meta/actions` and the action routes — after `prepareRequest`
 * and the request's own validation, before the row is read. Error bodies and
 * target summaries echo the id the client sent.
 */

let RidTicket: any;
let FwTicket: any;
let FwIssue: any;
let FwBoardRow: any;

const TICKETS = [
  { id: 1, code: "T-NEW", tenant: "a", status: "open", hiddenKey: "h1" },
  { id: 2, code: "T-B", tenant: "b", status: "open", hiddenKey: "h2" },
  { id: 3, code: "T-HOLD", tenant: "a", status: "open", hiddenKey: "h3" },
];
/** alias → the key it was renamed to. T-HOLD is ALSO the current key of row 3. */
const ALIASES: Record<string, string> = {
  "T-OLD": "T-NEW",
  "T-HOLD": "T-NEW",
  "T-B-OLD": "T-B",
};
const HELD = new Set(TICKETS.map((t) => t.code));

type THook = (
  ids: readonly TDbRowIdInput[],
  ctx: TDbRowIdsContext,
) => readonly TDbRowIdInput[] | Promise<readonly TDbRowIdInput[]>;

/** Every id resolves to one row — two request ids collapse to one resolved id. */
const collapse: THook = (ids) => ids.map(() => ({ code: "T-B" }));

/** The documented pattern: the current holder of a key wins; unknown aliases come back unchanged. */
const aliasHook: THook = (ids) =>
  ids.map((id) => {
    const key = typeof id === "object" ? id.code : id;
    if (typeof key !== "string" || HELD.has(key) || !ALIASES[key]) return id;
    return typeof id === "object" ? { code: ALIASES[key] } : ALIASES[key];
  });

interface TBootOpts {
  /** The hook (omitted: `resolveRowIds` is NOT overridden). */
  hook?: THook;
  /** Row overlay (transformOne). */
  overlay?: FilterExpr;
  /** Hides the `hiddenKey` unique index (hasField). */
  hideHiddenKey?: boolean;
  order?: string[];
}

let SEQ = 0;

async function boot(opts: TBootOpts = {}) {
  getMoostInfact()._cleanup();
  const space = createAdapter();
  const tickets = space.getTable(RidTicket);
  await tickets.insertMany(structuredClone(TICKETS) as never);
  const prefix = `rid${++SEQ}`;
  const { order } = opts;
  const removed: unknown[] = [];
  const guarded: unknown[] = [];
  const handled: Array<[string, unknown]> = [];
  const hookCalls: Array<{ ids: readonly TDbRowIdInput[]; ctx: TDbRowIdsContext }> = [];
  const hook = opts.hook;

  @Inherit()
  class Base extends AsDbController {
    protected async prepareRequest(ctx: TDbRequestContext) {
      order?.push(`prepare:${ctx.endpoint}`);
    }

    protected override transformOne(filter: FilterExpr): FilterExpr {
      order?.push("overlay");
      return opts.overlay ? ({ ...filter, ...opts.overlay } as FilterExpr) : filter;
    }

    protected override hasField(path: string): boolean {
      return !(opts.hideHiddenKey && path === "hiddenKey") && super.hasField(path);
    }

    protected override onRemove(id: unknown) {
      removed.push(id);
      return id;
    }

    protected override guardRemove(ctx: TDbRemoveGuardContext<any>) {
      guarded.push(ctx.id);
    }

    @Post("actions/touch")
    @DbAction("touch", { label: "Touch" })
    touch(@DbActionID() id: unknown) {
      handled.push(["touch", id]);
      return { id };
    }

    @Post("actions/touchRow")
    @DbAction("touchRow", { label: "Touch row" })
    touchRow(@DbActionRow() row: unknown) {
      handled.push(["touchRow", row]);
      return { ok: true };
    }

    @Post("actions/many")
    @DbAction("many", { label: "Many", onDisabledRows: "skip" })
    many(@DbActionIDs() ids: unknown) {
      handled.push(["many", ids]);
      return { ids };
    }

    @Post("actions/manyStrict")
    @DbAction("manyStrict", { label: "Many strict" })
    manyStrict(@DbActionRows() rows: unknown) {
      handled.push(["manyStrict", rows]);
      return { ok: true };
    }

    @Post("actions/manyLock")
    @DbAction("manyLock", {
      label: "Many lock",
      disabled: (rows: any[]) => rows.map((r) => (r.code === "T-LOCK" ? "locked" : false)),
    })
    manyLock(@DbActionRows() rows: unknown) {
      handled.push(["manyLock", rows]);
      return { ok: true };
    }

    @Post("actions/targeted")
    @DbAction("targeted", { label: "Targeted", queryTarget: true })
    async targeted(@DbActionTarget() target: TDbActionTarget) {
      for await (const batch of target.batches()) handled.push(["targeted", batch.ids]);
      return target.summary();
    }
  }

  @TableController(tickets, prefix)
  @Inherit()
  class Hooked extends Base {
    protected override resolveRowIds(ids: readonly TDbRowIdInput[], ctx: TDbRowIdsContext) {
      order?.push("resolve");
      hookCalls.push({ ids, ctx });
      return hook!(ids, ctx);
    }
  }

  @TableController(tickets, prefix)
  @Inherit()
  class Plain extends Base {}

  const http = await bootHttp(hook ? Hooked : Plain);
  const url = (path: string) => (path.startsWith("?") ? `/${prefix}${path}` : `/${prefix}/${path}`);
  const send = (method: string, path: string, body?: unknown) => http(method, url(path), body);
  return { send, tickets, removed, guarded, handled, hookCalls };
}

beforeAll(async () => {
  await prepareFixtures();
  ({ RidTicket } = await import("./fixtures/row-ids.as"));
  ({ FwTicket, FwIssue, FwBoardRow } = await import("./fixtures/fw3-actions.as"));
});

describe("not overridden", () => {
  it("every endpoint issues exactly the 0.1.147 queries", async () => {
    const { send, tickets } = await boot();
    const findOneByRow = vi.spyOn(tickets, "findOneByRow");
    const findOne = vi.spyOn(tickets, "findOne");
    const deleteOne = vi.spyOn(tickets, "deleteOne");
    expect((await send("GET", "one/T-NEW")).body.id).toBe(1);
    expect((await send("GET", "one?code=T-NEW")).body.id).toBe(1);
    expect(findOneByRow).toHaveBeenCalledTimes(2);
    findOneByRow.mockClear();
    expect((await send("GET", "meta/actions/1")).body.actions).toContain("touch");
    expect(findOneByRow).toHaveBeenCalledTimes(1);
    findOne.mockClear();
    expect((await send("POST", "actions/touchRow", { ids: { id: 1 } })).status).toBe(201);
    expect(findOne).toHaveBeenCalledTimes(1);
    expect((await send("DELETE", "T-NEW")).body.deletedCount).toBe(1);
    expect(deleteOne).toHaveBeenCalledTimes(1);
    // an alias is just a miss
    expect((await send("GET", "one/T-OLD")).status).toBe(404);
  });
});

describe("/one", () => {
  it("resolves a path alias and a ?-form alias to the canonical row", async () => {
    const { send, hookCalls } = await boot({ hook: aliasHook });
    expect((await send("GET", "one/T-OLD")).body).toMatchObject({ id: 1, code: "T-NEW" });
    expect((await send("GET", "one?code=T-OLD")).body).toMatchObject({ id: 1, code: "T-NEW" });
    expect(hookCalls.map((c) => c.ids)).toEqual([["T-OLD"], [{ code: "T-OLD" }]]);
    expect(hookCalls.map((c) => c.ctx.purpose)).toEqual(["one", "one"]);
  });

  it("an object for a scalar input reads that identification; a scalar resolves PK-first", async () => {
    const { send } = await boot({ hook: () => [{ id: 2 }] });
    expect((await send("GET", "one/whatever")).body).toMatchObject({ id: 2, code: "T-B" });
    const scalar = await boot({ hook: () => ["T-B"] });
    expect((await scalar.send("GET", "one?code=x")).body).toMatchObject({ id: 2 });
    // a numeric scalar is the primary key (PK first)
    const pk = await boot({ hook: () => [3] });
    expect((await pk.send("GET", "one/x")).body).toMatchObject({ id: 3 });
  });

  it("unchanged ids behave as today; the current holder of a key wins over an alias", async () => {
    const { send } = await boot({ hook: aliasHook });
    expect((await send("GET", "one/T-NEW")).body.id).toBe(1);
    expect((await send("GET", "one/T-HOLD")).body).toMatchObject({ id: 3, code: "T-HOLD" });
    expect((await send("GET", "one/T-NOPE")).status).toBe(404);
  });

  it("runs after prepareRequest and the request's validation, with the row overlay in ctx", async () => {
    const order: string[] = [];
    const overlay = { tenant: "a" } as FilterExpr;
    const { send, hookCalls } = await boot({ hook: aliasHook, order, overlay });
    expect((await send("GET", "one/T-OLD?$select=nope")).status).toBe(400);
    expect(hookCalls).toHaveLength(0);
    order.length = 0;
    expect((await send("GET", "one/T-OLD")).status).toBe(200);
    expect(order).toEqual(["prepare:one", "overlay", "resolve"]);
    expect(hookCalls[0].ctx.overlay).toEqual(overlay);
  });
});

describe("DELETE", () => {
  it("DELETE /:id and DELETE ?code= delete the canonical row; onRemove / guardRemove see the resolved id", async () => {
    const { send, removed, guarded, tickets } = await boot({ hook: aliasHook });
    expect((await send("DELETE", "T-OLD")).body).toMatchObject({ deletedCount: 1 });
    expect(removed).toEqual(["T-NEW"]);
    expect(guarded).toEqual(["T-NEW"]);
    expect(await tickets.findOne({ filter: { id: 1 } } as never)).toBeNull();
    expect((await send("DELETE", "?code=T-B-OLD")).body).toMatchObject({ deletedCount: 1 });
    expect(removed).toEqual(["T-NEW", { code: "T-B" }]);
    expect(await tickets.findOne({ filter: { id: 2 } } as never)).toBeNull();
  });

  it("onRemove returning undefined is still a 500", async () => {
    getMoostInfact()._cleanup();
    const tickets = createAdapter().getTable(RidTicket);
    await tickets.insertMany(structuredClone(TICKETS) as never);
    @TableController(tickets, "ridv")
    @Inherit()
    class Ctrl extends AsDbController {
      protected override resolveRowIds(ids: readonly TDbRowIdInput[]) {
        return ids;
      }

      protected override onRemove() {
        return undefined;
      }
    }
    const http = await bootHttp(Ctrl);
    expect((await http("DELETE", "/ridv/T-NEW")).status).toBe(500);
  });

  it("an out-of-overlay alias deletes nothing", async () => {
    const { send, tickets } = await boot({
      hook: aliasHook,
      overlay: { tenant: "a" } as FilterExpr,
    });
    expect((await send("DELETE", "T-B-OLD")).status).toBe(404);
    expect(await tickets.findOne({ filter: { id: 2 } } as never)).not.toBeNull();
  });
});

describe("/meta/actions", () => {
  it("resolves the scalar and the ?-form to the canonical row's actions", async () => {
    const { send, hookCalls } = await boot({ hook: aliasHook });
    const all = (await send("GET", "meta/actions/T-NEW")).body;
    expect(all.actions).toContain("touch");
    expect((await send("GET", "meta/actions/T-OLD")).body).toEqual(all);
    expect((await send("GET", "meta/actions?code=T-OLD")).body).toEqual(all);
    expect((await send("GET", "meta/actions/T-NOPE")).body).toEqual({ actions: [] });
    expect(hookCalls.map((c) => c.ctx.purpose)).toEqual(Array(4).fill("available"));
  });
});

describe("actions", () => {
  it("'row': the handler's @DbActionID gets the canonical id; ctx carries purpose/action/level", async () => {
    const { send, handled, hookCalls } = await boot({ hook: aliasHook });
    const res = await send("POST", "actions/touch", { ids: { code: "T-OLD" } });
    expect(res.status).toBe(201);
    expect(handled).toEqual([["touch", { code: "T-NEW" }]]);
    expect(hookCalls[0].ids).toEqual([{ code: "T-OLD" }]);
    expect(hookCalls[0].ctx).toMatchObject({ purpose: "action", action: "touch", level: "row" });
    const row = await send("POST", "actions/touchRow", { ids: { code: "T-OLD" } });
    expect(row.status).toBe(201);
    expect(handled[1][1]).toMatchObject({ id: 1, code: "T-NEW" });
  });

  it("'rows': stale and canonical ids of one row collapse (first wins); level is 'rows'", async () => {
    const { send, handled, hookCalls } = await boot({ hook: aliasHook });
    const res = await send("POST", "actions/many", {
      ids: [{ code: "T-OLD" }, { code: "T-NEW" }, { id: 3 }],
    });
    expect(res.status).toBe(201);
    expect(handled).toEqual([["many", [{ code: "T-NEW" }, { id: 3 }]]]);
    expect(hookCalls[0].ctx).toMatchObject({ purpose: "action", action: "many", level: "rows" });
  });

  it("a hook error passes through; a wrong length, a malformed id and a scalar are server bugs (500)", async () => {
    const thrown = await boot({
      hook: () => {
        throw new HttpError(409, "alias retired");
      },
    });
    expect((await thrown.send("POST", "actions/touch", { ids: { code: "T-OLD" } })).status).toBe(
      409,
    );
    for (const bad of [
      [] as TDbRowIdInput[],
      [{ $ne: "x" }],
      [{ tenant: "a" }],
      ["T-NEW"],
      [{ code: { $ne: "x" } }],
    ]) {
      const { send } = await boot({ hook: () => bad });
      const res = await send("POST", "actions/touch", { ids: { code: "T-OLD" } });
      expect(res.status, JSON.stringify(bad)).toBe(500);
    }
  });

  it("an id over a unique index hasField hides is not a valid output", async () => {
    const { send } = await boot({ hook: () => [{ hiddenKey: "h1" }], hideHiddenKey: true });
    expect((await send("POST", "actions/touch", { ids: { code: "T-OLD" } })).status).toBe(500);
    expect((await send("GET", "one/T-OLD")).status).toBe(500);
  });

  it("query-target ids never reach the hook", async () => {
    const { send, hookCalls } = await boot({ hook: aliasHook });
    const res = await send("POST", "actions/targeted", { query: { q: "tenant=a" } });
    expect(res.status).toBe(201);
    expect(res.body.matched).toBe(2);
    expect(hookCalls).toHaveLength(0);
  });

  it("order: prepareRequest → row overlay → resolveRowIds", async () => {
    const order: string[] = [];
    const { send } = await boot({ hook: aliasHook, order });
    await send("POST", "actions/touch", { ids: { code: "T-OLD" } });
    expect(order).toEqual(["prepare:action", "overlay", "resolve"]);
  });
});

describe("with actionRowScope", () => {
  it("order: prepareRequest → row overlay → resolveRowIds → actionRowScope (ids resolved, pre-load) → row load", async () => {
    getMoostInfact()._cleanup();
    const tickets = createAdapter().getTable(RidTicket);
    await tickets.insertMany(structuredClone(TICKETS) as never);
    const order: string[] = [];
    const scopeIds: unknown[] = [];
    vi.spyOn(tickets, "findOne").mockImplementation(async () => {
      order.push("load");
      return { id: 1, code: "T-NEW" } as never;
    });
    @TableController(tickets, "ridscope")
    @Inherit()
    class Ctrl extends AsDbController {
      protected async prepareRequest() {
        order.push("prepare");
      }

      protected override transformOne(filter: FilterExpr): FilterExpr {
        order.push("overlay");
        return filter;
      }

      protected override resolveRowIds(ids: readonly TDbRowIdInput[]) {
        order.push("resolve");
        return ids.map(() => ({ id: 1 }));
      }

      protected override actionRowScope(_action: string, ctx?: { ids: readonly unknown[] }) {
        order.push("scope");
        scopeIds.push(ctx?.ids);
        return { tenant: "a" } as FilterExpr;
      }

      @Post("actions/touchRow")
      @DbAction("touchRow", { label: "Touch row" })
      touchRow(@DbActionRow() row: unknown) {
        return { row };
      }
    }
    const http = await bootHttp(Ctrl);
    const res = await http("POST", "/ridscope/actions/touchRow", { ids: { code: "T-OLD" } });
    expect(res.status).toBe(201);
    expect(order).toEqual(["prepare", "overlay", "resolve", "scope", "load"]);
    expect(scopeIds).toEqual([[{ id: 1 }]]);
  });
});

describe("output validation", () => {
  it("a scalar output on /one is resolved like a path scalar; a wrong length is a 500", async () => {
    const { send } = await boot({ hook: () => ["T-B", "extra"] });
    expect((await send("GET", "one/x")).status).toBe(500);
    const nul = await boot({ hook: () => [null as never] });
    expect((await nul.send("GET", "one/x")).status).toBe(500);
  });
});

describe("no leaks under a row overlay", () => {
  const overlay = { tenant: "a" } as FilterExpr;

  it("an alias of an unreachable row, a missing id and an unknown alias answer identically", async () => {
    const { send } = await boot({ hook: aliasHook, overlay });
    const probes = ["T-B-OLD", "T-MISSING", "T-NOPE"];
    const answer = async (
      method: string,
      path: (p: string) => string,
      body?: (p: string) => unknown,
    ) => {
      const out = [];
      for (const p of probes) out.push(await send(method, path(p), body?.(p)));
      return out;
    };
    for (const results of [
      await answer("GET", (p) => `one/${p}`),
      await answer("GET", (p) => `one?code=${p}`),
      await answer("DELETE", (p) => p),
      await answer("DELETE", (p) => `?code=${p}`),
      await answer("GET", (p) => `meta/actions/${p}`),
      await answer("GET", (p) => `meta/actions?code=${p}`),
      await answer(
        "POST",
        () => "actions/touch",
        (p) => ({ ids: { code: p } }),
      ),
      await answer(
        "POST",
        () => "actions/touchRow",
        (p) => ({ ids: { code: p } }),
      ),
    ]) {
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
    }
  });

  it("'rows' refusals and target summaries list the REQUEST id; the handler gets the resolved id", async () => {
    const { send, handled } = await boot({ hook: aliasHook, overlay });
    const strict = await send("POST", "actions/manyStrict", {
      ids: [{ code: "T-OLD" }, { code: "T-B-OLD" }],
    });
    expect(strict.status).toBe(409);
    expect(strict.body.ids).toEqual([{ code: "T-B-OLD" }]);
    expect(JSON.stringify(strict.body)).not.toContain('T-B"');
    const skip = await send("POST", "actions/many", {
      ids: [{ code: "T-OLD" }, { code: "T-B-OLD" }],
    });
    expect(skip.status).toBe(201);
    expect(handled.at(-1)).toEqual(["many", [{ code: "T-NEW" }]]);
    // all refused: the zero-survivor error lists the request ids too
    const none = await send("POST", "actions/many", { ids: [{ code: "T-B-OLD" }] });
    expect(none.status).toBe(409);
    expect(none.body.ids).toEqual([{ code: "T-B-OLD" }]);
  });

  it("two request ids collapsing to one resolved id are ALL echoed (no alias grouping leak)", async () => {
    const { send, handled } = await boot({ hook: collapse, overlay });
    // refused (the row is outside the overlay): one resolved id, echoed as every request id
    const strict = await send("POST", "actions/manyStrict", {
      ids: [{ code: "ALIAS-1" }, { code: "ALIAS-2" }],
    });
    expect(strict.status).toBe(409);
    expect(strict.body.ids).toEqual([{ code: "ALIAS-1" }, { code: "ALIAS-2" }]);
    const skip = await send("POST", "actions/many", {
      ids: [{ code: "ALIAS-1" }, { code: "ALIAS-2" }],
    });
    expect(skip.status).toBe(409);
    expect(skip.body.ids).toEqual([{ code: "ALIAS-1" }, { code: "ALIAS-2" }]);
    // reachable: the handler gets the one resolved id
    const open = await boot({ hook: collapse });
    const ok = await open.send("POST", "actions/many", {
      ids: [{ code: "ALIAS-1" }, { code: "ALIAS-2" }],
    });
    expect(ok.status).toBe(201);
    expect(open.handled.at(-1)).toEqual(["many", [{ code: "T-B" }]]);
    expect(handled).toEqual([]);
  });

  it("a row action's 409 (disabled) carries the request id", async () => {
    getMoostInfact()._cleanup();
    const tickets = createAdapter().getTable(RidTicket);
    await tickets.insertMany(structuredClone(TICKETS) as never);
    @TableController(tickets, "ridd")
    @Inherit()
    class Ctrl extends AsDbController {
      protected override resolveRowIds(ids: readonly TDbRowIdInput[]) {
        return aliasHook(ids, { purpose: "action" });
      }

      @Post("actions/lock")
      @DbAction("lock", { label: "Lock", disabled: () => [true] })
      lock(@DbActionID() id: unknown) {
        return { id };
      }
    }
    const http = await bootHttp(Ctrl);
    const res = await http("POST", "/ridd/actions/lock", { ids: { code: "T-OLD" } });
    expect(res.status).toBe(409);
    expect(res.body.id).toEqual({ code: "T-OLD" });
  });
});

describe("every request id is judged on its own, in request order", () => {
  const overlay = { tenant: "a" } as FilterExpr;
  /** ALIAS-* all resolve to the out-of-scope T-B; every other id stays as is. */
  const aliasesToB: THook = (ids) =>
    ids.map((id) => ((id as any).code.startsWith("ALIAS") ? { code: "T-B" } : id));
  const aliases = (ids: string[]) => ids.map((code) => ({ code }));

  it("two aliases of one unreachable row are indistinguishable from two distinct rows (order, count)", async () => {
    const { send } = await boot({ hook: aliasesToB, overlay });
    const strict = await send("POST", "actions/manyStrict", {
      ids: aliases(["ALIAS-1", "MISS-X", "ALIAS-2"]),
    });
    expect(strict.status).toBe(409);
    // request order — NOT regrouped as [ALIAS-1, ALIAS-2, MISS-X]
    expect(strict.body.ids).toEqual(aliases(["ALIAS-1", "MISS-X", "ALIAS-2"]));
  });

  it("'reasons' stay aligned with the request ids", async () => {
    const { send, tickets } = await boot({ hook: aliasesToB, overlay });
    await tickets.insertOne({
      id: 4,
      code: "T-LOCK",
      tenant: "a",
      status: "open",
      hiddenKey: "h4",
    } as never);
    const res = await send("POST", "actions/manyLock", {
      ids: aliases(["ALIAS-1", "ALIAS-2", "T-LOCK"]),
    });
    expect(res.status).toBe(409);
    expect(res.body.ids).toEqual(aliases(["ALIAS-1", "ALIAS-2", "T-LOCK"]));
    expect(res.body.reasons).toEqual([null, null, "locked"]);
  });

  it("'matched' counts request ids, not resolved ones (skip mode and streamed target)", async () => {
    const hook: THook = (ids) =>
      ids.map((id) => ((id as any).code.startsWith("ALIAS") ? { code: "T-NEW" } : id));
    const open = await boot({ hook });
    const res = await open.send("POST", "actions/targeted", {
      ids: aliases(["ALIAS-1", "T-B", "ALIAS-2", "MISS-X"]),
    });
    expect(res.status).toBe(201);
    expect(res.body.matched).toBe(4);
    expect(res.body.processed).toBe(3);
    expect(res.body.skipped).toEqual([{ id: { code: "MISS-X" } }]);
    // the handler runs the row once
    expect(open.handled.at(-1)).toEqual(["targeted", [{ code: "T-NEW" }, { code: "T-B" }]]);
  });

  it("a streamed @DbActionTarget refusal lists every request id in request order", async () => {
    const { send } = await boot({ hook: aliasesToB, overlay });
    const res = await send("POST", "actions/targeted", {
      ids: aliases(["ALIAS-1", "MISS-X", "ALIAS-2", "ALIAS-3"]),
    });
    expect(res.status).toBe(201);
    expect(res.body.matched).toBe(4);
    expect(res.body.processed).toBe(0);
    expect(res.body.skipped.map((e: any) => e.id)).toEqual(
      aliases(["ALIAS-1", "MISS-X", "ALIAS-2", "ALIAS-3"]),
    );
  });
});

describe("@DbActionsFrom", () => {
  it("the view resolves its own id, then the source's hook (purpose 'available') maps the source id", async () => {
    getMoostInfact()._cleanup();
    const space = createAdapter();
    await space
      .getTable(FwTicket)
      .insertMany([{ key: "T1", teamId: "a", status: "open" }] as never);
    const issues = space.getTable(FwIssue);
    await issues.insertMany([
      { id: 1, ticketKey: "T1", status: "open", title: "one" },
      { id: 2, ticketKey: "T1", status: "open", title: "two" },
    ] as never);
    const board = space.getTable(FwBoardRow);
    await board.insertMany([
      { rowId: 10, issueId: 1, ticketKey: "T1", title: "one", teamId: "a" },
    ] as never);
    const sourceCalls: Array<{ ids: readonly TDbRowIdInput[]; purpose: string }> = [];
    const viewCalls: Array<readonly TDbRowIdInput[]> = [];

    @TableController(issues, "ridsrc")
    @Inherit()
    class IssueCtrl extends AsDbController {
      // issue 99 was merged into issue 1
      protected override resolveRowIds(ids: readonly TDbRowIdInput[], ctx: TDbRowIdsContext) {
        sourceCalls.push({ ids, purpose: ctx.purpose });
        return ids.map((id) => (typeof id === "object" && String(id.id) === "99" ? { id: 1 } : id));
      }

      @Post("actions/close")
      @DbAction("close", { label: "Close" })
      close(@DbActionID() id: unknown) {
        return { id };
      }
    }

    @TableController(board, "ridview")
    @DbActionsFrom(() => IssueCtrl, { idMap: { id: "issueId" } })
    @Inherit()
    class BoardCtrl extends AsDbReadableController {
      protected override resolveRowIds(ids: readonly TDbRowIdInput[]) {
        viewCalls.push(ids);
        // row 999 was renumbered to 10
        return ids.map((id) =>
          typeof id === "object" && String(id.rowId) === "999" ? { rowId: 10 } : id,
        );
      }
    }

    const http = await bootHttp(IssueCtrl, BoardCtrl);
    const res = await http("GET", "/ridview/meta/actions?rowId=999&issueId=99");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.actions).toEqual(["close"]);
    // the `?` form carries strings, as for /one
    expect(viewCalls).toEqual([[{ rowId: "999" }]]);
    expect(sourceCalls).toEqual([{ ids: [{ id: "99" }], purpose: "available" }]);
  });
});

describe("@DbActionsFrom never forwards a raw alias to the source", () => {
  it("a delegation path the request's identification named comes from the resolved id only", async () => {
    getMoostInfact()._cleanup();
    const space = createAdapter();
    await space
      .getTable(FwTicket)
      .insertMany([{ key: "T1", teamId: "a", status: "open" }] as never);
    const issues = space.getTable(FwIssue);
    await issues.insertMany([{ id: 1, ticketKey: "T1", status: "open", title: "one" }] as never);
    const tickets = space.getTable(RidTicket);
    await tickets.insertMany(structuredClone(TICKETS) as never);
    const sourceCalls: Array<readonly TDbRowIdInput[]> = [];

    @TableController(issues, "ridsrc2")
    @Inherit()
    class IssueCtrl extends AsDbController {
      protected override resolveRowIds(ids: readonly TDbRowIdInput[]) {
        sourceCalls.push(ids);
        return ids;
      }

      @Post("actions/close")
      @DbAction("close", { label: "Close" })
      close(@DbActionID() id: unknown) {
        return { id };
      }
    }

    @TableController(tickets, "ridview2")
    @DbActionsFrom(() => IssueCtrl, { idMap: { id: "code" } })
    @Inherit()
    class BoardCtrl extends AsDbReadableController {
      // the alias resolves to an id that carries no `code` at all
      protected override resolveRowIds(ids: readonly TDbRowIdInput[]) {
        return ids.map(() => ({ id: 1 }));
      }
    }

    const http = await bootHttp(IssueCtrl, BoardCtrl);
    const res = await http("GET", "/ridview2/meta/actions?code=T-OLD");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(sourceCalls)).not.toContain("T-OLD");
  });
});

describe("value-help controllers", () => {
  it("do not carry the hook (their getOne is the seam)", () => {
    expect((AsValueHelpController.prototype as any).resolveRowIds).toBeUndefined();
  });
});
