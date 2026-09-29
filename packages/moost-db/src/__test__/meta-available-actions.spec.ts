/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll } from "vite-plus/test";
import type { FilterExpr, TMetaResponse } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { Post } from "@moostjs/event-http";
import { Inherit, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { AsDbReadableController } from "../as-db-readable.controller";
import { discoverRowLevelActions, getDbEndpoint } from "../index";
import type { TDbRequestContext, TDbRequestEndpoint } from "../as-readable.controller";
import { TableController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { DbActionRow } from "../actions/db-action-row.decorator";
import { bootHttp, prepareFixtures } from "./test-utils";

/**
 * `GET /meta/actions/:id` / `/meta/actions?…` (since 0.1.145): the actions
 * the caller may run on ONE row — exactly what calling each would do (the
 * `applyMetaOverlay` action set, the action's gate overlay, its `disabled`
 * rule on the fields its gate loads), without a read grant and without
 * disclosing whether an unreachable id exists. Real HTTP.
 */

let ScopeHookItem: any;
let ScopeHookLine: any;
let ScopeHookSlug: any;

const ITEMS = [
  { id: 1, owner: "u1", status: "open", secret: "s1" },
  { id: 2, owner: "u2", status: "locked", secret: "s2" },
];

const LINES = [
  { orderId: 1, lineNo: 1, owner: "u1" },
  { orderId: 1, lineNo: 2, owner: "u2" },
];

// "abc" is A's primary key AND B's unique slug.
const SLUGS = [
  { id: "abc", slug: "a-slug", owner: "u1" },
  { id: "b", slug: "abc", owner: "u2" },
];

const MODELS = {
  items: () => [ScopeHookItem, ITEMS],
  lines: () => [ScopeHookLine, LINES],
  slugs: () => [ScopeHookSlug, SLUGS],
} as const;

interface TBootOpts {
  /** `actionRowScope`. */
  scope?: (action: string) => FilterExpr | undefined;
  /** Actions `applyMetaOverlay` removes. */
  deny?: string[];
  /** `transformFilter` overlay — on every endpoint, or on read endpoints only. */
  overlay?: { filter: FilterExpr; readsOnly?: boolean };
  /** An `allowedActions` override. */
  allow?: (names: readonly string[]) => readonly string[] | Promise<readonly string[]>;
  model?: keyof typeof MODELS;
}

const READS: ReadonlySet<TDbRequestEndpoint> = new Set(["query", "pages", "one"]);
let PREFIX_SEQ = 0;

async function boot(opts: TBootOpts = {}) {
  getMoostInfact()._cleanup();
  const [model, seed] = MODELS[opts.model ?? "items"]();
  const table = createAdapter().getTable(model as any);
  await table.insertMany(structuredClone(seed) as never);
  const prefix = `avail${++PREFIX_SEQ}`;
  const endpoints: TDbRequestEndpoint[] = [];
  const counts = { overlay: 0 };

  @Inherit()
  class Base extends AsDbController {
    protected endpoint?: TDbRequestEndpoint;

    protected prepareRequest(ctx: TDbRequestContext) {
      endpoints.push(ctx.endpoint);
      this.endpoint = ctx.endpoint;
    }

    protected override actionRowScope(action: string) {
      return opts.scope?.(action);
    }

    protected override applyMetaOverlay(meta: TMetaResponse): TMetaResponse {
      counts.overlay++;
      const deny = opts.deny ?? [];
      return { ...meta, actions: meta.actions.filter((a) => !deny.includes(a.name)) };
    }

    @Post("actions/approve")
    @DbAction("approve", { label: "approve" })
    approve(@DbActionID() id: unknown) {
      return { id };
    }

    @Post("actions/reopen")
    @DbAction("reopen", {
      label: "reopen",
      requiredFields: ["status"],
      disabled: (rows: Array<{ status?: string }>) =>
        rows.map((r) => (r.status === "open" ? "already open" : false)),
    })
    reopen(@DbActionRow() row: unknown) {
      return { row };
    }

    // Judged on `status` alone — `secret` (loaded for `peek` in the same
    // read) must stay invisible to it, exactly as in its own gate.
    @Post("actions/probe")
    @DbAction("probe", {
      label: "probe",
      requiredFields: ["status"],
      disabled: (rows: Array<{ secret?: string }>) =>
        rows.map((r) => (r.secret === undefined ? false : "saw secret")),
    })
    probe(@DbActionRow() row: unknown) {
      return { row };
    }

    @Post("actions/peek")
    @DbAction("peek", { label: "peek", requiredFields: ["secret"] })
    peek(@DbActionRow() row: unknown) {
      return { row };
    }

    @Post("actions/bulk")
    @DbAction("bulk", { label: "bulk" })
    bulk(@DbActionIDs() ids: unknown) {
      return { ids };
    }
  }

  let Mid: typeof Base = Base;
  if (opts.allow) {
    const allow = opts.allow;
    @Inherit()
    class Allowing extends Base {
      protected override allowedActions(names: readonly string[]) {
        return allow(names);
      }
    }
    Mid = Allowing;
  }

  let Bound: Function;
  if (opts.overlay) {
    const { filter, readsOnly } = opts.overlay;
    @TableController(table, prefix)
    class Overlaid extends Mid {
      protected override transformFilter(f: FilterExpr): FilterExpr {
        return readsOnly && !READS.has(this.endpoint!) ? f : ({ $and: [f, filter] } as FilterExpr);
      }
    }
    Bound = Overlaid;
  } else {
    @TableController(table, prefix)
    class Plain extends Mid {}
    Bound = Plain;
  }

  const http = await bootHttp(Bound);
  const send = (method: string, path: string, body?: unknown) =>
    http(method, `/${prefix}/${path}`, body);
  const available = async (path: string) => {
    const res = await send("GET", `meta/actions${path}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  return { available, send, endpoints, counts, Bound };
}

const ALL_ON_1 = {
  actions: ["approve", "probe", "peek", "bulk"],
  disabledReasons: { reopen: "already open" },
};

beforeAll(async () => {
  await prepareFixtures();
  ({ ScopeHookItem, ScopeHookLine, ScopeHookSlug } =
    await import("./fixtures/action-row-scope-hook.as"));
});

describe("GET /meta/actions/:id", () => {
  it("lists the runnable actions with disabled reasons; prepareRequest runs first", async () => {
    const { available, endpoints } = await boot();
    expect(await available("/1")).toEqual(ALL_ON_1);
    expect(await available("/2")).toEqual({
      actions: ["approve", "reopen", "probe", "peek", "bulk"],
    });
    expect(endpoints).toEqual(["availableActions", "availableActions"]);
  });

  it("drops actions applyMetaOverlay denies", async () => {
    const { available } = await boot({ deny: ["approve", "reopen"] });
    expect(await available("/1")).toEqual({ actions: ["probe", "peek", "bulk"] });
  });

  it("drops actions whose actionRowScope the row misses", async () => {
    const { available } = await boot({
      scope: (a) => (a === "approve" || a === "reopen" ? { owner: "u2" } : undefined),
    });
    expect(await available("/1")).toEqual({ actions: ["probe", "peek", "bulk"] });
    expect((await available("/2")).actions).toEqual(["approve", "reopen", "probe", "peek", "bulk"]);
  });

  it("unknown and out-of-scope ids answer the same empty list", async () => {
    const { available } = await boot({ overlay: { filter: { owner: "u1" } } });
    expect(await available("/99")).toEqual({ actions: [] });
    expect(await available("/2")).toEqual({ actions: [] });
    expect(await available("/1")).toEqual(ALL_ON_1);
  });

  it("does not depend on a read grant: a row the caller cannot read still lists its actions", async () => {
    const { available, send } = await boot({
      overlay: { filter: { owner: "u1" }, readsOnly: true },
    });
    expect((await send("GET", "one/2")).status).toBe(404);
    expect((await available("/2")).actions).toContain("approve");
    expect((await send("POST", "actions/approve", { ids: { id: 2 } })).status).toBe(201);
  });

  it("the composite form follows the /one?… rules", async () => {
    const { available, send } = await boot({
      model: "lines",
      deny: ["reopen", "probe", "peek"], // their requiredFields are not on this table
      scope: (a) => (a === "approve" ? { owner: "u1" } : undefined),
    });
    expect((await available("?orderId=1&lineNo=1")).actions).toContain("approve");
    expect((await available("?orderId=1&lineNo=2")).actions).not.toContain("approve");
    expect(await available("?orderId=9&lineNo=9")).toEqual({ actions: [] });
    expect((await send("GET", "meta/actions?orderId=1")).status).toBe(400);
  });

  it("resolves the id ONCE like /one — a scope never re-points it to another row", async () => {
    const { available, send } = await boot({
      model: "slugs",
      deny: ["reopen", "probe", "peek"], // their requiredFields are not on this table
      scope: (a) => (a === "approve" ? { owner: "u2" } : undefined),
    });
    // "abc" is A (u1) by primary key; B (u2) only shares the value as its slug.
    expect((await available("/abc")).actions).not.toContain("approve");
    expect((await send("POST", "actions/approve", { ids: { id: "abc" } })).status).toBe(404);
    expect((await available("/b")).actions).toContain("approve");
  });
});

describe("allowedActions", () => {
  it("narrows $actions and /meta/actions without building the /meta overlay", async () => {
    const { available, send, counts } = await boot({
      allow: (names) => names.filter((n) => n !== "approve" && n !== "peek"),
    });
    expect(await available("/1")).toEqual({
      actions: ["probe", "bulk"],
      disabledReasons: { reopen: "already open" },
    });
    const rows = (await send("GET", "query?$actions=true&$sort=id")).body;
    expect(rows[1].$actions).toEqual(["reopen", "probe", "bulk"]);
    expect(counts.overlay).toBe(0);
  });

  it("may be async; names outside the offered set are ignored", async () => {
    const { available } = await boot({ allow: async () => ["bulk", "nope"] });
    expect(await available("/2")).toEqual({ actions: ["bulk"] });
  });

  it("default: the applyMetaOverlay action set", async () => {
    const denied = await boot({ deny: ["approve"] });
    expect((await denied.available("/2")).actions).not.toContain("approve");
    expect(denied.counts.overlay).toBe(1);
  });
});

describe("getDbEndpoint / discoverRowLevelActions exports", () => {
  it("tags only the delegated handlers, on the class, an instance and a subclass", async () => {
    const { Bound } = await boot();
    expect(getDbEndpoint(Bound, "availableActionsById")).toBe("availableActions");
    expect(getDbEndpoint(Bound, "availableActions")).toBe("availableActions");
    expect(getDbEndpoint(Object.create(Bound.prototype), "availableActionsById")).toBe(
      "availableActions",
    );
    for (const method of ["query", "pages", "getOne", "meta", "insert", "approve"]) {
      expect(getDbEndpoint(Bound, method)).toBeUndefined();
    }
    class Override extends (Bound as typeof AsDbReadableController) {
      override async availableActionsById(id: string) {
        return super.availableActionsById(id);
      }
    }
    expect(getDbEndpoint(Override, "availableActionsById")).toBe("availableActions");
  });

  it("discoverRowLevelActions lists the row-level actions, memoized per class", async () => {
    const { Bound, available } = await boot();
    await available("/1"); // the controller discovers (and memoizes) with its own app
    const app = { getControllersOverview: () => [] } as any;
    const logger = { warn: () => {} } as any;
    const first = discoverRowLevelActions(Bound, app, logger);
    expect(first.map((e) => e.info.name)).toEqual(["approve", "reopen", "probe", "peek", "bulk"]);
    expect(discoverRowLevelActions(Bound, app, logger)).toBe(first);
  });
});
