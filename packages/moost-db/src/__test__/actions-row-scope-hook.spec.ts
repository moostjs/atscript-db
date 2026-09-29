/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import type { FilterExpr } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { Post } from "@moostjs/event-http";
import { Controller, Inherit, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { AsDbReadableController } from "../as-db-readable.controller";
import { TableController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { DbActionRow, DbActionRows } from "../actions/db-action-row.decorator";
import { bootHttp, prepareFixtures } from "./test-utils";

/**
 * `actionRowScope(action)` (since 0.1.145): the rows an action may run on.
 * The action gate enforces it (out-of-scope id → the 404 / 409 of a missing
 * one) and `$actions` reflects it — a row lists the action only inside its
 * scope, checked with one id-only query per distinct filter object against
 * the bound table, unaffected by `hasField`. End-to-end through
 * `MoostHttp.request()`.
 */

let ScopeHookItem: any;
let ScopeHookLine: any;
let ScopeHookCoded: any;

const ITEMS = [
  { id: 1, owner: "u1", status: "open", secret: "ok" },
  { id: 2, owner: "u2", status: "open", secret: "ok" },
  { id: 3, owner: "u2", status: "locked", secret: "no" },
  { id: 4, owner: "u1", status: "locked", secret: "no" },
];

const LINES = [
  { orderId: 1, lineNo: 1, owner: "u1" },
  { orderId: 1, lineNo: 2, owner: "u2" },
  { orderId: 2, lineNo: 1, owner: "u2" },
  { orderId: 2, lineNo: 2, owner: "u1" },
];

const CODED = [
  { id: 1, code: "c1", owner: "u1" },
  { id: 2, code: "c2", owner: "u2" },
];

const MODELS = {
  items: () => [ScopeHookItem, ITEMS],
  lines: () => [ScopeHookLine, LINES],
  coded: () => [ScopeHookCoded, CODED],
} as const;

type TScope = (action: string) => FilterExpr | undefined | Promise<FilterExpr | undefined>;

const openRows = (rows: Array<{ status?: string }>) =>
  rows.map((r) => (r.status === "open" ? "already open" : false));

/**
 * The actions under test; `hideSecret` adds a `hasField` override hiding
 * `secret`, `oneOverlay` a `transformOne` override (each only when asked).
 */
function defineBase({ hideSecret, oneOverlay }: Pick<TBootOpts, "hideSecret" | "oneOverlay">) {
  @Inherit()
  class Base extends AsDbController {
    @Post("actions/approve")
    @DbAction("approve", { label: "approve" })
    approve(@DbActionID() id: unknown) {
      return { id };
    }

    @Post("actions/archive")
    @DbAction("archive", { label: "archive" })
    archive(@DbActionRow() row: unknown) {
      return { row };
    }

    @Post("actions/reopen")
    @DbAction("reopen", { label: "reopen", requiredFields: ["status"], disabled: openRows })
    reopen(@DbActionID() id: unknown) {
      return { id };
    }

    @Post("actions/bulk")
    @DbAction("bulk", { label: "bulk" })
    bulk(@DbActionIDs() ids: unknown) {
      return { ids };
    }

    @Post("actions/bulkReopen")
    @DbAction("bulkReopen", { label: "bulkReopen", requiredFields: ["status"], disabled: openRows })
    bulkReopen(@DbActionRows() rows: unknown) {
      return { rows };
    }
  }
  let Out: typeof Base = Base;
  if (hideSecret) {
    @Inherit()
    class Hidden extends Out {
      protected override hasField(path: string): boolean {
        return path !== "secret" && super.hasField(path);
      }
    }
    Out = Hidden;
  }
  if (oneOverlay) {
    @Inherit()
    class OneScoped extends Out {
      protected override transformOne(filter: FilterExpr): FilterExpr {
        return { $and: [filter, oneOverlay!] } as FilterExpr;
      }
    }
    Out = OneScoped;
  }
  return Out;
}

let PREFIX_SEQ = 0;

interface TBootOpts {
  scope?: TScope;
  hideSecret?: boolean;
  /** A `transformOne` overlay — stricter than the (absent) `transformFilter` read overlay. */
  oneOverlay?: FilterExpr;
  model?: keyof typeof MODELS;
}

async function boot(opts: TBootOpts = {}) {
  getMoostInfact()._cleanup();
  const space = createAdapter();
  const [model, seed] = MODELS[opts.model ?? "items"]();
  const table = space.getTable(model as any);
  await table.insertMany(structuredClone(seed) as never);
  const Base = defineBase(opts);
  const prefix = `scopehook${++PREFIX_SEQ}`;

  let Bound: Function;
  if (opts.scope) {
    const { scope } = opts;
    @TableController(table, prefix)
    class Scoped extends Base {
      protected override actionRowScope(action: string) {
        return scope(action);
      }
    }
    Bound = Scoped;
  } else {
    @TableController(table, prefix)
    class Plain extends Base {}
    Bound = Plain;
  }

  const http = await bootHttp(Bound);
  const findMany = vi.spyOn(table, "findMany");
  const send = (method: string, path: string, body?: unknown) =>
    http(method, `/${prefix}/${path}`, body);
  const get = async (path: string): Promise<any> => {
    const res = await send("GET", path);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  const post = (action: string, ids: unknown) => send("POST", `actions/${action}`, { ids });
  return { get, post, findMany };
}

const U1 = { owner: "u1" } as FilterExpr;
const ownerU1: TScope = (action) => (action === "approve" ? U1 : undefined);

/** `id → $actions` of a row list. */
const actionsById = (rows: Array<{ id: number; $actions: string[] }>) =>
  Object.fromEntries(rows.map((r) => [r.id, r.$actions]));

beforeAll(async () => {
  await prepareFixtures();
  ({ ScopeHookItem, ScopeHookLine, ScopeHookCoded } =
    await import("./fixtures/action-row-scope-hook.as"));
});

describe("actionRowScope — enforced by the action gate", () => {
  const everyAction: TScope = () => U1;

  it("'row' id-only and @DbActionRow: out-of-scope → the 404 of a missing row", async () => {
    const { post } = await boot({ scope: everyAction });
    const missing = await post("approve", { id: 99 });
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe("Row not found for action identifier");
    expect(await post("approve", { id: 2 })).toEqual(missing);
    expect(await post("archive", { id: 2 })).toEqual(missing);
    expect((await post("approve", { id: 1 })).status).toBe(201);
    expect((await post("archive", { id: 1 })).status).toBe(201);
  });

  it("'row' with disabled: an out-of-scope row is a 404, never its 409 reason", async () => {
    const { post } = await boot({ scope: everyAction });
    expect((await post("reopen", { id: 3 })).status).toBe(404); // locked but foreign
    expect((await post("reopen", { id: 4 })).status).toBe(201);
    expect((await post("reopen", { id: 1 })).status).toBe(409);
  });

  it("'rows' ids and disabled rows: out-of-scope ids fail like missing ones", async () => {
    const { post } = await boot({ scope: everyAction });
    const bulk = await post("bulk", [{ id: 1 }, { id: 2 }]);
    expect(bulk.status).toBe(409);
    expect(bulk.body.ids).toEqual([{ id: 2 }]);
    expect((await post("bulk", [{ id: 1 }, { id: 4 }])).status).toBe(201);
    const gated = await post("bulkReopen", [{ id: 3 }, { id: 4 }]);
    expect(gated.status).toBe(409);
    expect(gated.body.ids).toEqual([{ id: 3 }]);
    expect((await post("bulkReopen", [{ id: 4 }])).status).toBe(201);
  });

  it("scopes only the actions it returns a filter for", async () => {
    const { post } = await boot({ scope: ownerU1 });
    expect((await post("approve", { id: 2 })).status).toBe(404);
    expect((await post("archive", { id: 2 })).status).toBe(201);
  });

  it("an `opts.table` action on a plain controller is never scoped", async () => {
    getMoostInfact()._cleanup();
    const table = createAdapter().getTable(ScopeHookItem);
    await table.insertMany(structuredClone(ITEMS));
    const prefix = `plainhook${++PREFIX_SEQ}`;
    @Controller(prefix)
    class PlainCtrl {
      protected actionRowScope() {
        return U1;
      }
      @Post("act")
      @DbAction("act", { label: "act", table })
      act(@DbActionRow() row: unknown) {
        return { row };
      }
    }
    const send = await bootHttp(PlainCtrl);
    expect((await send("POST", `/${prefix}/act`, { ids: { id: 2 } })).status).toBe(201);
  });
});

describe("actionRowScope — reflected in $actions (/query, /pages)", () => {
  it("rows outside an action's scope lose that action; other actions remain", async () => {
    const { get } = await boot({ scope: ownerU1 });
    const rows = await get("query?$actions=true&$sort=id");
    expect(actionsById(rows)).toEqual({
      1: ["approve", "archive", "bulk"],
      2: ["archive", "bulk"],
      3: ["archive", "reopen", "bulk", "bulkReopen"],
      4: ["approve", "archive", "reopen", "bulk", "bulkReopen"],
    });
    const page = await get("pages?$actions=true&$sort=id&$page=1&$size=10");
    expect(actionsById(page.data)).toEqual(actionsById(rows));
  });

  it("an out-of-scope action gets no $disabledReasons entry; an in-scope disabled one keeps its reason", async () => {
    const { get } = await boot({ scope: (a) => (a === "reopen" ? U1 : undefined) });
    const rows = await get("query?$actions=true&$sort=id");
    expect(rows[0].$disabledReasons).toEqual({
      reopen: "already open",
      bulkReopen: "already open",
    });
    expect(rows[1].$disabledReasons).toEqual({ bulkReopen: "already open" });
    expect(rows[2].$actions).toEqual(["approve", "archive", "bulk", "bulkReopen"]);
  });

  it("an async hook works; actions returning the SAME filter object share one query", async () => {
    const { get, findMany } = await boot({
      scope: async (a) => (a === "approve" || a === "archive" ? U1 : undefined),
    });
    const rows = await get("query?$actions=true&$sort=id");
    expect(actionsById(rows)).toEqual({
      1: ["approve", "archive", "bulk"],
      2: ["bulk"],
      3: ["reopen", "bulk", "bulkReopen"],
      4: ["approve", "archive", "reopen", "bulk", "bulkReopen"],
    });
    expect(findMany).toHaveBeenCalledTimes(2); // the read + one scope query
    expect(findMany.mock.calls[1][0]).toEqual({
      filter: { $and: [{ $or: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] }, U1] },
      controls: { $select: ["id"] },
    });
  });

  it("distinct filter objects run one query each", async () => {
    const { get, findMany } = await boot({
      scope: (a) =>
        a === "approve" ? { owner: "u1" } : a === "archive" ? { owner: "u1" } : undefined,
    });
    await get("query?$actions=true&$sort=id");
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("hook not overridden, or returning undefined / {}: no restriction and no extra query", async () => {
    const all = {
      1: ["approve", "archive", "bulk"],
      2: ["approve", "archive", "bulk"],
      3: ["approve", "archive", "reopen", "bulk", "bulkReopen"],
      4: ["approve", "archive", "reopen", "bulk", "bulkReopen"],
    };
    for (const opts of [{}, { scope: () => undefined }, { scope: () => ({}) as FilterExpr }]) {
      const { get, findMany } = await boot(opts);
      expect(actionsById(await get("query?$actions=true&$sort=id"))).toEqual(all);
      expect(findMany).toHaveBeenCalledTimes(1);
    }
  });

  it("neither allowedActions nor applyMetaOverlay overridden: allowedActions is never called", async () => {
    const spy = vi.spyOn(AsDbReadableController.prototype as any, "allowedActions");
    try {
      const { get } = await boot({ scope: ownerU1 });
      expect((await get("query?$actions=true&$sort=id"))[0].$actions).toContain("approve");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("no $actions: the hook is never consulted", async () => {
    const scope = vi.fn(ownerU1);
    const { get, findMany } = await boot({ scope });
    expect((await get("query?$sort=id"))[0]).not.toHaveProperty("$actions");
    expect(scope).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("a scope over a hasField-hidden field still filters; the field never reaches the response", async () => {
    const { get } = await boot({
      hideSecret: true,
      scope: (a) => (a === "approve" ? ({ secret: "ok" } as FilterExpr) : undefined),
    });
    const rows = await get("query?$actions=true&$sort=id&$select=id,owner");
    expect(actionsById(rows)).toEqual({
      1: ["approve", "archive", "bulk"],
      2: ["approve", "archive", "bulk"],
      3: ["archive", "reopen", "bulk", "bulkReopen"],
      4: ["archive", "reopen", "bulk", "bulkReopen"],
    });
    for (const row of rows) expect(row).not.toHaveProperty("secret");
  });

  it("$select without the primary key: rows match by preferredId; the response shape is unchanged", async () => {
    const plain = await boot({ model: "coded" });
    const before = await plain.get("query?$actions=true&$sort=code&$select=owner");
    const { get, findMany } = await boot({ model: "coded", scope: ownerU1 });
    const rows = await get("query?$actions=true&$sort=code&$select=owner");
    expect(rows).toEqual([
      { ...before[0], $actions: before[0].$actions },
      { ...before[1], $actions: before[1].$actions.filter((a: string) => a !== "approve") },
    ]);
    expect(findMany.mock.calls[0][0]).toMatchObject({ controls: { $select: ["owner", "code"] } });
    expect(findMany.mock.calls[1][0]).toEqual({
      filter: { $and: [{ $or: [{ code: "c1" }, { code: "c2" }] }, U1] },
      controls: { $select: ["code"] },
    });
  });

  it("a scoped action's check includes the gate's row overlay (transformOne stricter than the read)", async () => {
    const { get, post } = await boot({ scope: ownerU1, oneOverlay: { status: "open" } });
    const rows = await get("query?$actions=true&$sort=id");
    // Row 4 is u1's but locked: the gate (owner AND status) refuses it.
    expect(rows[3].$actions).not.toContain("approve");
    expect(rows[0].$actions).toContain("approve");
    expect((await post("approve", { id: 4 })).status).toBe(404);
    expect((await post("approve", { id: 1 })).status).toBe(201);
  });

  it("an empty result runs no scope query", async () => {
    const { get, findMany } = await boot({ scope: ownerU1 });
    expect(await get("query?$actions=true&owner=nobody")).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

describe("actionRowScope — reflected in $actions (/one)", () => {
  it("/one/:id lists the action only on an in-scope row", async () => {
    const { get } = await boot({ scope: ownerU1 });
    expect((await get("one/1?$actions=true")).$actions).toEqual(["approve", "archive", "bulk"]);
    expect((await get("one/2?$actions=true")).$actions).toEqual(["archive", "bulk"]);
  });

  it("/one with a $select excluding the key keeps the response shape", async () => {
    const plain = await boot({ model: "coded" });
    const before = await plain.get("one/c2?$actions=true&$select=owner");
    const { get } = await boot({ model: "coded", scope: ownerU1 });
    expect(await get("one/c2?$actions=true&$select=owner")).toEqual({
      ...before,
      $actions: before.$actions.filter((a: string) => a !== "approve"),
    });
    expect((await get("one/c1?$actions=true&$select=owner")).$actions).toContain("approve");
  });
});

describe("actionRowScope — composite primary key", () => {
  it("$actions, /one?… and the gate match rows by the full key", async () => {
    const { get, post, findMany } = await boot({ model: "lines", scope: ownerU1 });
    const rows = await get("query?$actions=true&$sort=orderId,lineNo&$select=owner");
    expect(rows.map((r: { $actions: string[] }) => r.$actions.includes("approve"))).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect(findMany.mock.calls[1][0]).toMatchObject({
      filter: { $and: [{ $or: expect.any(Array) }, U1] },
      controls: { $select: ["lineNo", "orderId"] },
    });
    expect((await get("one?orderId=2&lineNo=2&$actions=true")).$actions).toContain("approve");
    expect((await get("one?orderId=2&lineNo=1&$actions=true")).$actions).not.toContain("approve");
    expect((await post("approve", { orderId: 2, lineNo: 1 })).status).toBe(404);
    expect((await post("approve", { orderId: 2, lineNo: 2 })).status).toBe(201);
  });
});
