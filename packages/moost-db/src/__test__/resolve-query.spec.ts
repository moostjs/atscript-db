/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import type { FilterExpr } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { createAdapter as createSqlite } from "@atscript/db-sqlite";
import { Body, HttpError, Post, Get } from "@moostjs/event-http";
import { useRouteParams } from "@wooksjs/event-core";
import {
  Controller,
  Inherit,
  createEventContext,
  current,
  getMoostInfact,
  key,
  useControllerContext,
  withControllerContext,
} from "moost";

import { AsDbController } from "../as-db.controller";
import type { TDbRequestContext } from "../as-readable.controller";
import { TableController } from "../decorators";
import { DbDecorations } from "../decorations/db-decorations.decorator";
import { DbAction } from "../actions/db-action.decorator";
import { bootHttp, prepareFixtures } from "./test-utils";

/**
 * `resolveQuery` (since 0.1.149): the rows of ANOTHER controller (or this
 * one, on a custom route) matching a `/query` string, resolved as that
 * controller's READ for the current caller — from a command the app wrote.
 */

let ResolveIssue: any;
let ResolveNote: any;
let ResolveOwner: any;
let ResolveIssueDecorations: any;
let ResolveLine: any;
let ResolveLoose: any;
let ResolveKeyed: any;

const ISSUES = [
  {
    id: 1,
    ticketKey: "T1",
    status: "open",
    title: "alpha one",
    pin: "p1",
    code: "c1",
    contact: { email: "a@x.io", phone: "555", secretPin: "9" },
  },
  { id: 2, ticketKey: "T1", status: "open", title: "alpha two", pin: "p2", code: "c2" },
  { id: 3, ticketKey: "T2", status: "closed", title: "beta three", pin: "p3", code: "c3" },
  { id: 4, ticketKey: "T2", status: "open", title: "beta four", pin: "p4", code: "c4" },
  { id: 5, ticketKey: "T3", status: "open", title: "gamma five", pin: "p5", code: "c5" },
];

let SEQ = 0;
const endpointKey = key<string>("rq.endpoint");
/** Field visibility state, as a permission layer keeps it per request. */
const hiddenKey = key<string[]>("rq.hidden");
const hiddenNow = () => (current().has(hiddenKey) ? current().get(hiddenKey) : []);

interface TBoot {
  hide?: string[];
  deny?: boolean;
  readScope?: FilterExpr;
  contexts?: TDbRequestContext[];
  /** The target's `transformFilter` reads this route param like the multi-tenant recipe. */
  tenantRecipe?: boolean;
  /** Replaces the table (default: memory issues). */
  table?: any;
  rows?: Array<Record<string, unknown>>;
  searchFallback?: (filter: FilterExpr | undefined, controls: Record<string, unknown>) => any;
  /** Spied: `queryTargetScope` calls. */
  scopeSpy?: (action: string) => void;
  /** The target builds its own per-request visibility state in `prepareRequest` (none hidden). */
  stateful?: boolean;
  /** Also routes the target at `/:tenant/...`. */
  tenantPrefix?: boolean;
}

async function boot(opts: TBoot = {}) {
  getMoostInfact()._cleanup();
  const space = createAdapter();
  const issues = opts.table ?? space.getTable(ResolveIssue);
  await issues.insertMany(structuredClone(opts.rows ?? ISSUES) as never);
  const prefix = `rq${++SEQ}`;
  const seenParams: unknown[] = [];

  @TableController(issues, opts.tenantPrefix ? `${prefix}/:tenant` : prefix)
  @Inherit()
  @DbDecorations(ResolveIssueDecorations)
  class Target extends AsDbController {
    protected async prepareRequest(ctx: TDbRequestContext) {
      if (opts.deny && ctx.endpoint === "query") throw new HttpError(403, "no read grant");
      if (ctx.endpoint === "query") opts.contexts?.push(ctx);
      current().set(endpointKey, ctx.endpoint);
      if (opts.stateful) current().set(hiddenKey, []);
    }

    protected override hasField(path: string): boolean {
      if (opts.stateful && hiddenNow().includes(path)) return false;
      return !opts.hide?.includes(path) && super.hasField(path);
    }

    protected override transformFilter(filter: FilterExpr): FilterExpr {
      if (opts.tenantRecipe) {
        const tenant = useRouteParams<{ tenant: string }>().get("tenant");
        seenParams.push(tenant);
        if (tenant === undefined) throw new HttpError(400, "tenant route param missing");
      }
      return opts.readScope ? ({ $and: [filter, opts.readScope] } as FilterExpr) : filter;
    }

    protected override queryTargetScope(action: string) {
      opts.scopeSpy?.(action);
      return super.queryTargetScope(action);
    }

    protected override applySearchFallback(
      filter: FilterExpr | undefined,
      controls: Record<string, unknown>,
    ) {
      return opts.searchFallback
        ? opts.searchFallback(filter, controls)
        : super.applySearchFallback(filter, controls);
    }

    /** A same-controller custom route resolving its own rows. */
    @Get("self-resolve")
    async selfResolve() {
      return (await this.resolveQuery("")).map((r) => r.id);
    }

    @Post("actions/probe")
    @DbAction("probe", { label: "Probe" })
    async probe(@Body() b: { q: unknown; opts?: any }) {
      return this.resolveQuery(b.q as never, b.opts);
    }
  }

  @Controller(`${prefix}c`)
  class Caller {
    @Post("run")
    async run(@Body() b: { q: unknown; opts?: any }) {
      const target = await useControllerContext().instantiate(Target);
      const rows = await target.resolveQuery(b.q as never, b.opts);
      return { rows, leaked: current().has(endpointKey) };
    }

    @Post("hidden/run")
    async hiddenRun(@Body() b: { q: unknown; opts?: any }) {
      // The CALLER's own visibility state: hides `title` for itself.
      current().set(hiddenKey, ["title"]);
      const target = await useControllerContext().instantiate(Target);
      const rows = await target.resolveQuery(b.q as never, b.opts);
      return { rows, callerHidden: current().get(hiddenKey) };
    }

    @Post("x/:tenant/run")
    async tenantRun(@Body() b: { q: unknown; opts?: any }) {
      const target = await useControllerContext().instantiate(Target);
      return target.resolveQuery(b.q as never, b.opts);
    }

    /** Like a `@DbActionsFrom` source hook: a fork of this route whose controller is the target. */
    @Post("x/:tenant/forked")
    async tenantForked(@Body() b: { q: unknown; opts?: any }) {
      const target = await useControllerContext().instantiate(Target);
      return withControllerContext(target, "query", () =>
        target.resolveQuery(b.q as never, b.opts),
      );
    }

    @Post("tx")
    async tx(@Body() b: { q: unknown; fail?: boolean }) {
      const target = await useControllerContext().instantiate(Target);
      return issues.getAdapter().withTransaction(async () => {
        await issues.insertOne({
          id: 99,
          ticketKey: "T1",
          status: "open",
          title: "marker",
          code: "c99",
        } as never);
        const rows = await target.resolveQuery(b.q as never);
        if (b.fail) throw new HttpError(500, "boom");
        return { ids: rows.map((r) => r.id) };
      });
    }
  }

  const http = await bootHttp(Target, Caller);
  const run = (q: unknown, o?: any) => http("POST", `/${prefix}c/run`, { q, opts: o });
  return { http, run, cmd: `/${prefix}c`, issues, prefix, seenParams, Target, space };
}

beforeAll(async () => {
  await prepareFixtures();
  ({
    ResolveIssue,
    ResolveNote,
    ResolveOwner,
    ResolveIssueDecorations,
    ResolveLine,
    ResolveLoose,
    ResolveKeyed,
  } = await import("./fixtures/resolve-query.as"));
});

const ids = (res: { body: any }) => res.body.rows.map((r: any) => r.id);

describe("resolveQuery — input and rows", () => {
  it("takes a /query string (leading ? ok) or an envelope; rows come in identity order", async () => {
    const { run } = await boot();
    expect(ids(await run("status=open"))).toEqual([1, 2, 4, 5]);
    expect(ids(await run("?ticketKey=T2"))).toEqual([3, 4]);
    expect(ids(await run({ q: "status=open", exclude: [{ id: 2 }] }))).toEqual([1, 4, 5]);
    expect(ids(await run(""))).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns identity + select only; adapter extras and other columns are dropped", async () => {
    const { run } = await boot();
    const res = await run("ticketKey=T1", { select: ["title"] });
    expect(res.body.rows).toEqual([
      { id: 1, title: "alpha one" },
      { id: 2, title: "alpha two" },
    ]);
    expect((await run("ticketKey=T1")).body.rows).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe("resolveQuery — runs as a read of the target", () => {
  it("calls prepareRequest once with endpoint query and the CLIENT filter; its state stays in the child", async () => {
    const contexts: TDbRequestContext[] = [];
    const { run } = await boot({ contexts });
    const res = await run("status=open", { scope: { ticketKey: "T1" } });
    expect(res.status).toBe(201);
    expect(res.body.leaked).toBe(false);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].endpoint).toBe("query");
    expect(JSON.stringify(contexts[0].filter)).toContain("status");
    expect(JSON.stringify(contexts[0].filter)).not.toContain("ticketKey");
  });

  it("a refusal of prepareRequest (403) propagates", async () => {
    const { run } = await boot({ deny: true });
    expect((await run("")).status).toBe(403);
  });

  it("applies the read overlay (transformFilter) and never calls queryTargetScope", async () => {
    const scopeSpy = vi.fn();
    const { run } = await boot({ readScope: { status: "open" } as FilterExpr, scopeSpy });
    expect(ids(await run("ticketKey=T2"))).toEqual([4]);
    expect(scopeSpy).not.toHaveBeenCalled();
  });
});

describe("resolveQuery — gates", () => {
  it("a hidden or unknown field in the filter or select → 400 Unknown field", async () => {
    const { run } = await boot({ hide: ["title"] });
    for (const [q, o] of [
      ["title=x", undefined],
      ["nope=1", undefined],
      ["", { select: ["title"] }],
      ["", { select: ["nope"] }],
      ["", { select: ["unreadCount"] }], // a @DbDecorations key
      ["", { select: ["owner"] }], // a navigation path
    ] as const) {
      const res = await run(q, o);
      expect(res.status, JSON.stringify([q, o])).toBe(400);
      expect(res.body.errors[0].message).toContain("Unknown field");
    }
  });

  it("a hidden @db.writeOnly select answers Unknown field (no existence oracle)", async () => {
    const { run } = await boot({ hide: ["pin"] });
    const res = await run("", { select: ["pin"] });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toContain("Unknown field");
  });

  it("an object parent expands to its visible, non-write-only leaves", async () => {
    const { run } = await boot();
    const res = await run("id=1", { select: ["contact"] });
    expect(res.body.rows).toEqual([{ id: 1, contact: { email: "a@x.io", phone: "555" } }]);
    expect(JSON.stringify(res.body)).not.toContain("secretPin");
    expect(JSON.stringify(res.body)).not.toContain('"9"');
  });

  it("an object parent never returns a hasField-hidden leaf; all leaves hidden → 400", async () => {
    const hiddenEmail = await boot({ hide: ["contact.email"] });
    const res = await hiddenEmail.run("id=1", { select: ["contact"] });
    expect(res.body.rows).toEqual([{ id: 1, contact: { phone: "555" } }]);
    const none = await boot({ hide: ["contact.email", "contact.phone"] });
    const all = await none.run("id=1", { select: ["contact"] });
    expect(all.status).toBe(400);
    expect(all.body.errors[0].message).toContain('Unknown field "contact"');
  });

  it("a @db.writeOnly select → 400", async () => {
    const { run } = await boot();
    const res = await run("", { select: ["pin"] });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toContain("writeOnly");
  });

  it("$sort / $limit / $select / $with / $vector in q, and dryRun → TARGET_INVALID", async () => {
    const { run } = await boot();
    for (const q of ["$sort=id", "$limit=2", "$select=id", "$with=x", "$vector=x&$search=a"]) {
      const res = await run(q);
      expect(res.status, q).toBe(400);
      expect(res.body.code, q).toBe("TARGET_INVALID");
    }
    const dry = await run({ q: "", dryRun: true });
    expect(dry.status).toBe(400);
    expect(dry.body.code).toBe("TARGET_INVALID");
  });

  it("exclude by a field the identifications don't cover → 400", async () => {
    const { run } = await boot();
    expect((await run({ q: "", exclude: [{ title: "x" }] })).status).toBe(400);
  });

  it("programmer errors are plain Errors (500): bad cap, bad select", async () => {
    const { run } = await boot();
    expect((await run("", { cap: 0 })).status).toBe(500);
    expect((await run("", { select: [1] })).status).toBe(500);
  });

  it("outside any event → a clear Error", async () => {
    const { Target } = await boot();
    const target = new (Target as any)(
      { getLogger: () => console } as never,
      createAdapter().getTable(ResolveIssue),
    );
    await expect(target.resolveQuery("")).rejects.toThrow(/inside an event handler/);
  });
});

describe("resolveQuery — $search follows the READ's visibility", () => {
  it("a hidden fallback field → TARGET_INVALID; a visible one is applied", async () => {
    const hidden = await boot({ hide: ["title"] });
    const res = await hidden.run("$search=alpha");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TARGET_INVALID");
    expect(ids(await (await boot()).run("$search=alpha"))).toEqual([1, 2]);
  });

  it("a table with neither native search nor searchable columns → TARGET_INVALID", async () => {
    getMoostInfact()._cleanup();
    const notes = createAdapter().getTable(ResolveNote);
    const { run } = await boot({ table: notes, rows: [{ id: 1, body: "a" }] });
    const res = await run("$search=a");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TARGET_INVALID");
  });

  it("native search: search() with $limit cap+1, ordered by identity; scores dropped", async () => {
    const { run, issues } = await boot();
    vi.spyOn(issues, "isSearchable").mockReturnValue(true);
    const search = vi.spyOn(issues, "search").mockResolvedValue([
      { id: 2, $score: 3 },
      { id: 4, $score: 1 },
    ] as never);
    const res = await run("$search=alpha", { cap: 7 });
    expect(res.body.rows).toEqual([{ id: 2 }, { id: 4 }]);
    expect(search).toHaveBeenCalledTimes(1);
    const [term, query] = search.mock.calls[0] as any[];
    expect(term).toBe("alpha");
    expect(query.controls).toMatchObject({ $limit: 8, $sort: { id: 1 } });
  });

  it("an applySearchFallback override that applies the term is honoured", async () => {
    const { run } = await boot({
      hide: ["title"],
      searchFallback: (filter, controls) =>
        controls.$search ? ({ ticketKey: "T3" } as FilterExpr) : filter,
    });
    expect(ids(await run("$search=whatever"))).toEqual([5]);
  });
});

describe("resolveQuery — cap, expectCount, label", () => {
  const many = Array.from({ length: 1001 }, (_, i) => ({
    id: i + 1,
    ticketKey: "T1",
    status: "open",
    title: `t${i}`,
    code: `c${i}`,
  }));

  it("default cap 1000; opts.cap and q.maxRows lower it", async () => {
    const big = await boot({ rows: many });
    const res = await big.run("");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "TARGET_TOO_LARGE", cap: 1000 });
    const { run } = await boot();
    expect((await run("", { cap: 2 })).body).toMatchObject({ code: "TARGET_TOO_LARGE", cap: 2 });
    expect((await run({ q: "", maxRows: 3 }, { cap: 50 })).body).toMatchObject({ cap: 3 });
    expect((await run("", { cap: 5 })).status).toBe(201);
  });

  it("expectCount mismatch → 409 TARGET_CHANGED; the label is the calling action's name", async () => {
    const { run, http, prefix } = await boot();
    const plain = await run({ q: "status=open", expectCount: 3 });
    expect(plain.status).toBe(409);
    expect(plain.body).toMatchObject({ code: "TARGET_CHANGED", matched: 4, action: "" });
    const act = await http("POST", `/${prefix}/actions/probe`, {
      q: { q: "status=open", expectCount: 3 },
    });
    expect(act.body).toMatchObject({ code: "TARGET_CHANGED", action: "probe" });
  });
});

describe("resolveQuery — scope", () => {
  it("is ANDed, even on a hidden field, and is not shown to prepareRequest", async () => {
    const contexts: TDbRequestContext[] = [];
    const { run } = await boot({ hide: ["pin"], contexts });
    const res = await run("status=open", { scope: { pin: { $in: ["p1", "p4"] } } });
    expect(ids(res)).toEqual([1, 4]);
    expect(JSON.stringify(contexts[0].filter)).not.toContain("pin");
  });
});

describe("resolveQuery — route params", () => {
  it("from another controller the target's hooks see no route params (recipe fails closed)", async () => {
    const { http, seenParams, cmd } = await boot({ tenantRecipe: true });
    const res = await http("POST", `${cmd}/x/acme/run`, { q: "" });
    expect(res.status).toBe(400);
    expect(res.body.message ?? JSON.stringify(res.body)).toContain("tenant route param missing");
    expect(seenParams).toEqual([undefined]);
  });

  it("a forked child whose controller is the target (a source hook) does not inherit the route's params", async () => {
    const { http, seenParams, cmd } = await boot({ tenantRecipe: true });
    const res = await http("POST", `${cmd}/x/acme/forked`, { q: "" });
    expect(res.status).toBe(400);
    expect(seenParams).toEqual([undefined]);
  });

  it("a same-controller route keeps its own params", async () => {
    const { http, seenParams, prefix } = await boot({ tenantRecipe: true, tenantPrefix: true });
    const res = await http("GET", `/${prefix}/acme/self-resolve`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([1, 2, 3, 4, 5]);
    expect(seenParams).toEqual(["acme"]);
  });
});

describe("resolveQuery — transactions (sqlite)", () => {
  async function bootSqlite() {
    const space = createSqlite(":memory:", { transactionWaitTimeoutMs: 500 });
    await space.getAdapter(ResolveOwner).ensureTable();
    await space.getAdapter(ResolveIssue).ensureTable();
    const issues = space.getTable(ResolveIssue);
    return boot({ table: issues, rows: ISSUES.map(({ pin: _pin, ...r }) => r) });
  }

  it("joins the caller's open transaction: sees uncommitted writes without waiting; rolls back with it", async () => {
    const { http, issues, cmd } = await bootSqlite();
    const t0 = Date.now();
    const ok = await http("POST", `${cmd}/tx`, { q: "ticketKey=T1" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.ids).toEqual([1, 2, 99]);
    expect(Date.now() - t0).toBeLessThan(450);
    await issues.deleteOne(99 as never);
    const failed = await http("POST", `${cmd}/tx`, { q: "ticketKey=T1", fail: true });
    expect(failed.status).toBe(500);
    expect(await issues.findOne({ filter: { id: 99 } } as never)).toBeNull();
  });
});

describe("resolveQuery — the caller's state is not the target's", () => {
  it("the target's hasField reads the target's own prepareRequest state, not the caller's", async () => {
    // The caller hides `title` for itself; the target builds its own (nothing hidden).
    const { http, cmd } = await boot({ stateful: true });
    const res = await http("POST", `${cmd}/hidden/run`, {
      q: "$search=alpha",
      opts: { select: ["title"] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.rows).toEqual([
      { id: 1, title: "alpha one" },
      { id: 2, title: "alpha two" },
    ]);
    // ...and the caller's own state is untouched.
    expect(res.body.callerHidden).toEqual(["title"]);
  });
});

describe("resolveQuery — from a non-HTTP event", () => {
  // No CLI / workflow adapter is a devDependency of this package: a manual
  // event (`createEventContext`, no HTTP request in it) stands in.
  it("runs as a read of the target with the event's identity", async () => {
    const contexts: TDbRequestContext[] = [];
    const { Target, issues } = await boot({ contexts });
    const target = new (Target as any)({ getLogger: () => console } as never, issues);
    const rows = await createEventContext({ logger: console as never }, () =>
      target.resolveQuery("status=open", { select: ["title"] }),
    );
    expect(rows.map((r: any) => r.id)).toEqual([1, 2, 4, 5]);
    expect(rows[0]).toEqual({ id: 1, title: "alpha one" });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].endpoint).toBe("query");
  });

  it("the read's refusals reach the caller as HttpError", async () => {
    const { Target, issues } = await boot({ deny: true });
    const target = new (Target as any)({ getLogger: () => console } as never, issues);
    await expect(
      createEventContext({ logger: console as never }, () => target.resolveQuery("")),
    ).rejects.toMatchObject({ body: { statusCode: 403 } });
  });
});

describe("resolveQuery — index visibility and identifications", () => {
  const INDEXES = [
    { name: "byTitle", type: "text", fields: ["title"] },
    { name: "byStatus", type: "text", fields: ["status"], isDefault: true },
  ];
  async function bootNative(opts: TBoot) {
    const b = await boot(opts);
    vi.spyOn(b.issues, "isSearchable").mockReturnValue(true);
    vi.spyOn(b.issues, "getSearchIndexes").mockReturnValue(INDEXES as never);
    const search = vi.spyOn(b.issues, "search").mockResolvedValue([{ id: 2 }] as never);
    return { ...b, search };
  }

  it("a $index over a hidden field → 400 like a nonexistent index; a visible one is used", async () => {
    const hidden = await bootNative({ hide: ["title"] });
    const res = await hidden.run("$search=a&$index=byTitle");
    expect(res.status).toBe(400);
    expect(res.body.errors[0].path).toBe("$index");
    expect(hidden.search).not.toHaveBeenCalled();
    const ok = await bootNative({ hide: ["title"] });
    expect(ids(await ok.run("$search=a&$index=byStatus"))).toEqual([2]);
    expect(ok.search.mock.calls[0]![2]).toBe("byStatus");
  });

  it("a hidden DEFAULT index answers the index gate's 400, not TARGET_INVALID", async () => {
    const { run, search } = await bootNative({ hide: ["status"] });
    const res = await run("$search=a");
    expect(res.status).toBe(400);
    expect(res.body.code).toBeUndefined();
    expect(res.body.errors[0].path).toBe("$search");
    expect(search).not.toHaveBeenCalled();
  });

  it("exclude by a unique index over a hidden field → 400; a visible one works", async () => {
    const hidden = await boot({ hide: ["code"] });
    expect((await hidden.run({ q: "", exclude: [{ code: "c2" }] })).status).toBe(400);
    const { run } = await boot();
    expect(ids(await run({ q: "", exclude: [{ code: "c2" }] }))).toEqual([1, 3, 4, 5]);
  });
});

describe("resolveQuery — identity", () => {
  const bootOn = (table: any, rows: Array<Record<string, unknown>>) => boot({ table, rows });

  it("a composite key orders by every key field, in order", async () => {
    const { run } = await bootOn(createAdapter().getTable(ResolveLine), [
      { issueId: 2, lineNo: 1, status: "a" },
      { issueId: 1, lineNo: 2, status: "a" },
      { issueId: 1, lineNo: 1, status: "b" },
    ]);
    expect((await run("")).body.rows).toEqual([
      { issueId: 1, lineNo: 1 },
      { issueId: 1, lineNo: 2 },
      { issueId: 2, lineNo: 1 },
    ]);
  });

  it("no identity: rows are ordered by `select`; each field must be sortable", async () => {
    // SQLite: the memory adapter keys rows by identity, so it holds one identity-less row only.
    const space = createSqlite(":memory:");
    await space.getAdapter(ResolveLoose).ensureTable();
    const { run } = await bootOn(space.getTable(ResolveLoose), [
      { label: "b", blob: { a: "x" } },
      { label: "a", blob: { a: "y" } },
    ]);
    expect((await run("", { select: ["label"] })).body.rows).toEqual([
      { label: "a" },
      { label: "b" },
    ]);
    const unsortable = await run("", { select: ["label", "blob"] });
    expect(unsortable.status).toBe(400);
    expect(unsortable.body.code).toBe("TARGET_INVALID");
    expect(unsortable.body.message).toContain("blob");
    // Neither identity nor `select`: a programmer error.
    expect((await run("")).status).toBe(500);
  });

  it("a declared preferredId orders the rows (not the primary key)", async () => {
    const { run } = await bootOn(createAdapter().getTable(ResolveKeyed), [
      { id: 1, ref: "c" },
      { id: 2, ref: "a" },
      { id: 3, ref: "b" },
    ]);
    expect((await run("")).body.rows.map((r: any) => r.ref)).toEqual(["a", "b", "c"]);
  });

  it("identity fields are returned even when hasField hides them", async () => {
    const { run } = await boot({ hide: ["id"] });
    expect((await run("ticketKey=T1&status=open")).body.rows).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
