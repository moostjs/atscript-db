/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import type { FilterExpr } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { HttpError, MoostHttp, Post } from "@moostjs/event-http";
import { current, key } from "@wooksjs/event-core";
import { useHeaders } from "@wooksjs/event-http";
import { Controller, Inherit, Moost, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import type { TDbRequestContext } from "../as-readable.controller";
import { TableController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { DbActionRow, DbActionRows } from "../actions/db-action-row.decorator";
import { prepareFixtures } from "./test-utils";

/**
 * `prepareRequest` runs for every `@DbAction` handler (since 0.1.143) —
 * `{ endpoint: "action", action }`, once per request, after the guards and
 * BEFORE the action's ids are validated, its rows loaded or its row overlay
 * built, on every level (row / rows / table, gated or not). A permission
 * layer resolves its policy there and needs no action guard of its own.
 */

let ScopeAct: any;

const SEED = [
  { id: 1, owner: "u1", status: "open", secret: "s1" },
  { id: 2, owner: "u2", status: "locked", secret: "s2" },
  { id: 3, owner: "u2", status: "open", secret: "s3" },
];

type Log = Array<string | TDbRequestContext>;
let log: Log = [];

/** The per-request owner `prepareRequest` resolves and `transformFilter` reads. */
const ownerKey = key<string>("test_action_owner");

function defineBase() {
  @Inherit()
  class ActsBase extends AsDbController {
    @Post("actions/approve")
    @DbAction("approve", { label: "approve" })
    approve(@DbActionID() id: { id: number }) {
      log.push("handler:approve");
      return { id };
    }

    @Post("actions/peek")
    @DbAction("peek", { label: "peek", requiredFields: ["owner", "status"] })
    peek(@DbActionID() id: unknown, @DbActionRow() row: unknown) {
      log.push("handler:peek");
      return { id, row };
    }

    @Post("actions/gated")
    @DbAction("gated", {
      label: "gated",
      requiredFields: ["status"],
      disabled: (rows: Array<{ status: string }>) => rows.map((r) => r.status === "locked"),
    })
    gated(@DbActionRow() row: unknown) {
      log.push("handler:gated");
      return { row };
    }

    @Post("actions/bulk")
    @DbAction("bulk", { label: "bulk", requiredFields: ["owner"] })
    bulk(@DbActionIDs() ids: unknown, @DbActionRows() rows: unknown) {
      log.push("handler:bulk");
      return { ids, rows };
    }

    @Post("actions/export")
    @DbAction("export", { label: "export" })
    exportAll() {
      log.push("handler:export");
      return { ok: true };
    }
  }
  return ActsBase;
}

type Res = { status: number; body: any };
let PREFIX_SEQ = 0;

async function boot(mode: "policy" | "deny" | "plain") {
  getMoostInfact()._cleanup();
  const space = createAdapter();
  const table = space.getTable(ScopeAct);
  await table.insertMany(structuredClone(SEED));
  const Base = defineBase();
  const prefix = `prep${++PREFIX_SEQ}`;

  let Ctrl: Function;
  if (mode === "plain") {
    @TableController(table, prefix)
    class PlainActs extends Base {}
    Ctrl = PlainActs;
  } else {
    @TableController(table, prefix)
    class PolicyActs extends Base {
      protected async prepareRequest(ctx: TDbRequestContext): Promise<void> {
        log.push({ ...ctx });
        await Promise.resolve();
        if (mode === "deny") throw new HttpError(403, `denied ${ctx.action}`);
        current().set(ownerKey, String(useHeaders()["x-owner"] ?? "nobody"));
      }
      protected override transformFilter(filter: FilterExpr): FilterExpr {
        // Throws when read before `prepareRequest` resolved the owner.
        const owner = current().get(ownerKey);
        log.push(`transformFilter:${owner}`);
        return { $and: [filter, { owner }] } as FilterExpr;
      }
      protected override hasField(path: string): boolean {
        log.push(`hasField:${path}`);
        return super.hasField(path);
      }
    }
    Ctrl = PolicyActs;
  }

  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(Ctrl);
  await app.init();
  const call = async (path: string, body?: unknown, owner = "u1"): Promise<Res> => {
    const res = await http.request(`/${prefix}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner": owner },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res!.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res!.status, body: parsed };
  };
  return { call };
}

beforeAll(async () => {
  await prepareFixtures();
  ({ ScopeAct } = await import("./fixtures/action-scope.as"));
});

beforeEach(() => {
  log = [];
});

const prepared = (action: string) => ({ endpoint: "action", action });

describe("prepareRequest on @DbAction handlers", () => {
  it("'row' id-only action: runs once, first — before id validation (hasField) and the overlay", async () => {
    const { call } = await boot("policy");
    const res = await call("actions/approve", { ids: { id: 1 } });
    expect(res.status).toBe(201);
    expect(log[0]).toEqual(prepared("approve"));
    expect(log.filter((e) => typeof e === "object")).toHaveLength(1);
    expect(log.at(-1)).toBe("handler:approve");
    expect(log).toContain("transformFilter:u1");
  });

  it("the policy it resolves scopes the ids (another owner's row → the missing-row 404)", async () => {
    const { call } = await boot("policy");
    expect((await call("actions/approve", { ids: { id: 3 } })).status).toBe(404);
    expect((await call("actions/approve", { ids: { id: 3 } }, "u2")).status).toBe(201);
  });

  it("a throw denies before anything else — even a malformed id answers the hook's 403", async () => {
    const { call } = await boot("deny");
    const malformed = await call("actions/approve", { ids: { nope: 1 } });
    expect(malformed.status).toBe(403);
    expect(malformed.body.message).toBe("denied approve");
    expect(log).toEqual([prepared("approve")]);
  });

  it("gated 'row' action: before the row load and the disabled predicate", async () => {
    const { call } = await boot("deny");
    const res = await call("actions/gated", { ids: { id: 2 } });
    expect(res.status).toBe(403);
    expect(log).toEqual([prepared("gated")]);
  });

  it("@DbActionID + @DbActionRow on one handler: still exactly one call", async () => {
    const { call } = await boot("policy");
    const res = await call("actions/peek", { ids: { id: 1 } });
    expect(res.status).toBe(201);
    expect(res.body.row).toEqual({ id: 1, owner: "u1", status: "open" });
    expect(log.filter((e) => typeof e === "object")).toEqual([prepared("peek")]);
  });

  it("'rows' action: before the ids / rows; the resolved policy scopes them", async () => {
    const denied = await boot("deny");
    expect((await denied.call("actions/bulk", { ids: [{ id: 1 }] })).status).toBe(403);
    expect(log).toEqual([prepared("bulk")]);

    log = [];
    const { call } = await boot("policy");
    const res = await call("actions/bulk", { ids: [{ id: 1 }] });
    expect(res.status).toBe(201);
    expect(log[0]).toEqual(prepared("bulk"));
    // Another owner's id fails like a missing one.
    expect((await call("actions/bulk", { ids: [{ id: 1 }, { id: 3 }] })).status).toBe(409);
  });

  it("'table' action: gets an interceptor for prepareRequest alone", async () => {
    const denied = await boot("deny");
    const res = await denied.call("actions/export");
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("denied export");
    expect(log).toEqual([prepared("export")]);

    log = [];
    const { call } = await boot("policy");
    expect((await call("actions/export")).status).toBe(201);
    expect(log).toEqual([prepared("export"), "handler:export"]);
  });

  it("a controller without prepareRequest runs its actions unchanged", async () => {
    const { call } = await boot("plain");
    expect((await call("actions/export")).status).toBe(201);
    expect((await call("actions/approve", { ids: { id: 3 } })).status).toBe(201);
    expect((await call("actions/gated", { ids: { id: 2 } })).status).toBe(409);
    expect(log).toEqual(["handler:export", "handler:approve"]);
  });

  it("a sync prepareRequest works too; CRUD routes keep their own endpoint names", async () => {
    getMoostInfact()._cleanup();
    const table = createAdapter().getTable(ScopeAct);
    await table.insertMany(structuredClone(SEED));
    const seen: TDbRequestContext[] = [];
    const prefix = `prep${++PREFIX_SEQ}`;
    @TableController(table, prefix)
    class SyncActs extends defineBase() {
      protected prepareRequest(ctx: TDbRequestContext): void {
        seen.push({ ...ctx });
      }
    }
    const app = new Moost();
    const http = new MoostHttp();
    app.adapter(http);
    app.registerControllers(SyncActs);
    await app.init();
    const res = await http.request(`/${prefix}/actions/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: { id: 2 } }),
    });
    expect(res!.status).toBe(201);
    await http.request(`/${prefix}/query`);
    expect(seen).toEqual([prepared("approve"), { endpoint: "query", controls: {} }]);
  });
});

describe("prepareRequest on a plain (non-readable) controller action", () => {
  it("an action bound through opts.table on a plain controller has no prepareRequest to run", async () => {
    getMoostInfact()._cleanup();
    const table = createAdapter().getTable(ScopeAct);
    await table.insertMany(structuredClone(SEED));
    @Controller(`plain${++PREFIX_SEQ}`)
    class PlainCtrl {
      @Post("act")
      @DbAction("act", { label: "act", table })
      act(@DbActionID() id: unknown) {
        return { id };
      }
    }
    const app = new Moost();
    const http = new MoostHttp();
    app.adapter(http);
    app.registerControllers(PlainCtrl);
    await app.init();
    const res = await http.request(`/plain${PREFIX_SEQ}/act`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: { id: 1 } }),
    });
    expect(res!.status).toBe(201);
  });
});
