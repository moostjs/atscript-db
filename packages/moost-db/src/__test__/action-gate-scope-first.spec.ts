/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import type { FilterExpr } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { Post } from "@moostjs/event-http";
import { Inherit, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import type { TDbRequestContext } from "../as-readable.controller";
import { TableController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { DbActionRow, DbActionRows } from "../actions/db-action-row.decorator";
import type { TDbActionScopeContext } from "../actions/scope-context";
import { bootHttp, prepareFixtures } from "./test-utils";

/**
 * Since 0.1.148 the action gate asks `actionRowScope` BEFORE loading rows
 * (when there is no row overlay and the ids are in `preferredId` shape): an
 * override that restricts nothing makes the gate load nothing (the 0.1.146
 * behaviour), a restriction joins the one row load (`id ∧ scope`).
 */

let FwIssue: any;
let FwTicket: any;
let RidTicket: any;

const ISSUES = [
  { id: 1, ticketKey: "T1", status: "open", title: "one" },
  { id: 2, ticketKey: "T1", status: "open", title: "two" },
  { id: 3, ticketKey: "T1", status: "done", title: "three" },
];
const TICKETS = [
  { id: 1, code: "c1", tenant: "a", status: "open", hiddenKey: "h1" },
  { id: 2, code: "c2", tenant: "a", status: "open", hiddenKey: "h2" },
];

type TScopeFn = (action: string, ctx: TDbActionScopeContext) => FilterExpr | undefined;

let SEQ = 0;

async function boot(
  scope: TScopeFn | undefined,
  opts: { overlay?: FilterExpr; order?: string[] } = {},
) {
  getMoostInfact()._cleanup();
  const space = createAdapter();
  await space.getTable(FwTicket).insertMany([{ key: "T1", teamId: "a", status: "open" }] as never);
  await space.getTable(FwIssue).insertMany(structuredClone(ISSUES) as never);
  await space.getTable(RidTicket).insertMany(structuredClone(TICKETS) as never);
  const issues = space.getTable(FwIssue);
  const tickets = space.getTable(RidTicket);
  const prefix = `sf${++SEQ}`;
  const calls: Array<{ action: string; ids: readonly Record<string, unknown>[] }> = [];
  const handled: unknown[] = [];
  const { order } = opts;

  const disabledDone = (rows: Array<{ status?: string }>) =>
    rows.map((r) => (r.status === "done" ? "already done" : false));

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

    protected override actionRowScope(action: string, ctx: TDbActionScopeContext) {
      order?.push("scope");
      calls.push({ action, ids: ctx.ids });
      return scope?.(action, ctx);
    }

    @Post("actions/idOnly")
    @DbAction("idOnly", { label: "Id only" })
    idOnly(@DbActionID() id: unknown) {
      handled.push(id);
      return { id };
    }

    @Post("actions/withRow")
    @DbAction("withRow", { label: "With row" })
    withRow(@DbActionRow() row: unknown) {
      handled.push(row);
      return { ok: true };
    }

    @Post("actions/guarded")
    @DbAction("guarded", { label: "Guarded", requiredFields: ["status"], disabled: disabledDone })
    guarded(@DbActionID() id: unknown) {
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
  }

  // The unique-index-shaped id: ids by `code`, the preferredId is the PK.
  @TableController(tickets, `${prefix}t`)
  @Inherit()
  class TicketCtrl extends AsDbController {
    protected override actionRowScope(action: string, ctx: TDbActionScopeContext) {
      calls.push({ action, ids: ctx.ids });
      return scope?.(action, ctx);
    }

    @Post("actions/touch")
    @DbAction("touch", { label: "Touch" })
    touch(@DbActionRow() row: unknown) {
      handled.push(row);
      return { ok: true };
    }
  }

  const http = await bootHttp(IssueCtrl, TicketCtrl);
  const findOne = vi.spyOn(issues, "findOne");
  const findMany = vi.spyOn(issues, "findMany");
  const send = (path: string, body?: unknown) => http("POST", `/${prefix}/${path}`, body);
  const sendTicket = (path: string, body?: unknown) => http("POST", `/${prefix}t/${path}`, body);
  return { send, sendTicket, calls, handled, findOne, findMany };
}

beforeAll(async () => {
  await prepareFixtures();
  ({ FwIssue, FwTicket } = await import("./fixtures/fw3-actions.as"));
  ({ RidTicket } = await import("./fixtures/row-ids.as"));
});

describe("scope-first gate — unrestricted scope", () => {
  it("'row' id-only runs with zero queries, for an existing and a missing id", async () => {
    const { send, handled, findOne, findMany, calls } = await boot(() => undefined);
    expect((await send("actions/idOnly", { ids: { id: 1 } })).status).toBe(201);
    expect((await send("actions/idOnly", { ids: { id: 99 } })).status).toBe(201);
    expect(handled).toEqual([{ id: 1 }, { id: 99 }]);
    expect(findOne).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    // the hook is asked once per evaluation, with the request's ids
    expect(calls).toEqual([
      { action: "idOnly", ids: [{ id: 1 }] },
      { action: "idOnly", ids: [{ id: 99 }] },
    ]);
  });

  it("`{}` and `null` count as unrestricted", async () => {
    for (const answer of [{}, null]) {
      const { send, findOne } = await boot(() => answer as never);
      expect((await send("actions/idOnly", { ids: { id: 99 } })).status).toBe(201);
      expect(findOne).not.toHaveBeenCalled();
    }
  });

  it("@DbActionRow on a missing id is a 404 after exactly one findOne (no scope in the filter)", async () => {
    const { send, findOne, findMany } = await boot(() => undefined);
    const res = await send("actions/withRow", { ids: { id: 99 } });
    expect(res.status).toBe(404);
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findOne.mock.calls[0][0].filter).toEqual({ id: 99 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("'rows' runs with no gate query; @DbActionRows keeps `undefined` gaps", async () => {
    const { send, handled, findOne, findMany } = await boot(() => undefined);
    expect((await send("actions/bulk", { ids: [{ id: 1 }, { id: 99 }] })).status).toBe(201);
    expect(handled).toEqual([[{ id: 1 }, { id: 99 }]]);
    expect(findMany).not.toHaveBeenCalled();
    // The handler-side loader keeps the gaps (the 0.1.146 behaviour).
    const reject = await send("actions/bulkRows", { ids: [{ id: 1 }, { id: 99 }] });
    expect(reject.status).toBe(201);
    expect(handled[1]).toEqual([expect.objectContaining({ id: 1 }), undefined]);
    expect(findOne).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

describe("scope-first gate — restricted scope", () => {
  const openOnly: TScopeFn = () => ({ status: "open" }) as FilterExpr;

  it("'row': exactly one findOne with { $and: [id, scope] }, no findMany; out-of-scope = missing = 404", async () => {
    const { send, findOne, findMany, handled } = await boot(openOnly);
    expect((await send("actions/idOnly", { ids: { id: 1 } })).status).toBe(201);
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findOne.mock.calls[0][0].filter).toEqual({ $and: [{ id: 1 }, { status: "open" }] });
    expect(findMany).not.toHaveBeenCalled();
    const outOfScope = await send("actions/idOnly", { ids: { id: 3 } });
    const missing = await send("actions/idOnly", { ids: { id: 99 } });
    expect(outOfScope.status).toBe(404);
    expect(outOfScope).toEqual(missing);
    expect(handled).toEqual([{ id: 1 }]);
  });

  it("'rows': one findMany; onDisabledRows skip / reject behave as before", async () => {
    const { send, findMany, handled } = await boot(openOnly);
    const skipped = await send("actions/bulk", { ids: [{ id: 1 }, { id: 3 }, { id: 99 }] });
    expect(skipped.status).toBe(201);
    expect(skipped.body.ids).toEqual([{ id: 1 }]);
    expect(findMany).toHaveBeenCalledTimes(1);
    findMany.mockClear();
    const rejected = await send("actions/bulkRows", { ids: [{ id: 1 }, { id: 3 }] });
    expect(rejected.status).toBe(409);
    expect(rejected.body.ids).toEqual([{ id: 3 }]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(handled).toHaveLength(1);
  });

  it("a `disabled` gate with a restricted scope loads once (the scope joins the load)", async () => {
    const { send, findOne, findMany, calls } = await boot(openOnly);
    expect((await send("actions/guarded", { ids: { id: 1 } })).status).toBe(201);
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    // disabled still judges the row
    const done = await send("actions/guarded", { ids: { id: 3 } });
    expect(done.status).toBe(404); // out of scope (status != open) before `disabled` is judged
  });

  it("an id in a unique-index shape takes the deferred path: the hook sees the loaded preferredId", async () => {
    const { sendTicket, calls, handled } = await boot(() => ({ tenant: "a" }) as FilterExpr);
    const res = await sendTicket("actions/touch", { ids: { code: "c2" } });
    expect(res.status).toBe(201);
    expect(handled[0]).toMatchObject({ id: 2, code: "c2" });
    expect(calls).toEqual([{ action: "touch", ids: [{ id: 2 }] }]);
  });
});

describe("scope-first gate — row overlay", () => {
  it("is unchanged: the row loads under the overlay, the hook sees only inside ids, order preserved", async () => {
    const order: string[] = [];
    const { send, calls, findOne } = await boot(() => undefined, {
      overlay: { status: "open" } as FilterExpr,
      order,
    });
    expect((await send("actions/idOnly", { ids: { id: 1 } })).status).toBe(201);
    expect((await send("actions/idOnly", { ids: { id: 3 } })).status).toBe(404);
    expect(findOne).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([{ action: "idOnly", ids: [{ id: 1 }] }]);
    expect(order.slice(0, 3)).toEqual(["prepare:action", "overlay", "scope"]);
  });
});
