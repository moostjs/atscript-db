import { describe, it, expect, beforeAll, afterEach } from "vite-plus/test";
import type { FilterExpr } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { MoostHttp, Post } from "@moostjs/event-http";
import { Inherit, Injectable, Moost, getMoostInfact, useControllerContext } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { DbActionRow, DbActionRows } from "../actions/db-action-row.decorator";
import { prepareFixtures } from "./test-utils";

/**
 * Action row overlays that resolve a `FOR_EVENT` dependency (the ARBAC
 * pattern: `transformFilter` → `useControllerContext().instantiate(...)`)
 * over a REAL HTTP server. Moost's HTTP adapter unregisters the event's DI
 * scope when the request stream ends — i.e. as soon as the body is read — so
 * the overlay must resolve before the action body is consumed. A `disabled`
 * gate used to load the ids (reading the body) first and answered 500
 * "The requested scope ... isn't registered." instead of its 409.
 * `MoostHttp.request()` pre-seeds the body and never ends the request early,
 * hence the listening server.
 */

let ScopeAct: any;

@Injectable("FOR_EVENT")
class Principal {
  readonly owner = "u1";
}

const SEED = [
  { id: 1, owner: "u1", status: "open", secret: "s1" },
  { id: 2, owner: "u1", status: "locked", secret: "s2" },
  { id: 3, owner: "u2", status: "open", secret: "s3" },
];

const locked = (rows: Array<{ status: string }>) =>
  rows.map((r) => (r.status === "locked" ? `Row is locked (status=${r.status})` : false));

@Inherit()
class ActsBase extends AsDbController {
  protected override async transformFilter(filter: FilterExpr): Promise<FilterExpr> {
    const principal = await useControllerContext().instantiate(Principal);
    return { $and: [filter, { owner: principal.owner }] } as FilterExpr;
  }

  @Post("actions/gated")
  @DbAction("gated", { requiredFields: ["status"], disabled: locked })
  gated(@DbActionRow() row: unknown) {
    return { row };
  }

  @Post("actions/gatedId")
  @DbAction("gatedId", { requiredFields: ["status"], disabled: locked })
  gatedId(@DbActionID() id: unknown) {
    return { id };
  }

  @Post("actions/bulkGated")
  @DbAction("bulkGated", { requiredFields: ["status"], disabled: locked })
  bulkGated(@DbActionRows() rows: unknown) {
    return { rows };
  }

  @Post("actions/bulkSkip")
  @DbAction("bulkSkip", { requiredFields: ["status"], disabled: locked, onDisabledRows: "skip" })
  bulkSkip(@DbActionIDs() ids: unknown) {
    return { ids };
  }

  @Post("actions/approve")
  @DbAction("approve")
  approve(@DbActionID() id: unknown) {
    return { id };
  }
}

let stop: (() => Promise<void>) | undefined;
let PREFIX_SEQ = 0;

async function boot() {
  getMoostInfact()._cleanup();
  const table = createAdapter().getTable(ScopeAct);
  await table.insertMany(structuredClone(SEED));
  const prefix = `evscope${++PREFIX_SEQ}`;

  @TableController(table, prefix)
  class Acts extends ActsBase {}

  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(Acts);
  await app.init();
  await http.listen(0);
  const server = http.getHttpApp().getServer() as { address(): { port: number } };
  const base = `http://127.0.0.1:${server.address().port}/${prefix}`;
  stop = async () => {
    await http.getHttpApp().close();
  };

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed };
  };
  return { call, table };
}

beforeAll(async () => {
  await prepareFixtures();
  ({ ScopeAct } = await import("./fixtures/action-scope.as"));
});

afterEach(async () => {
  await stop?.();
  stop = undefined;
});

describe("action row overlay resolving a FOR_EVENT dependency (real HTTP)", () => {
  it("'row' gate: a disabled row → 409, an enabled row → the handler, out-of-scope → 404", async () => {
    const { call } = await boot();
    const disabled = await call("POST", "actions/gated", { ids: { id: 2 } });
    expect(disabled.status).toBe(409);
    expect(disabled.body.message).toBe("Row is locked (status=locked)");

    const enabled = await call("POST", "actions/gated", { ids: { id: 1 } });
    expect(enabled.status).toBe(201);
    expect(enabled.body.row).toEqual({ id: 1, status: "open" });

    expect((await call("POST", "actions/gated", { ids: { id: 3 } })).status).toBe(404);
    expect((await call("POST", "actions/gatedId", { ids: { id: 2 } })).status).toBe(409);
    expect((await call("POST", "actions/gatedId", { ids: { id: 1 } })).status).toBe(201);
  });

  it("'rows' gate: reject → 409 listing the failing ids; skip → the survivors", async () => {
    const { call } = await boot();
    const rejected = await call("POST", "actions/bulkGated", { ids: [{ id: 1 }, { id: 2 }] });
    expect(rejected.status).toBe(409);
    expect(rejected.body.ids).toEqual([{ id: 2 }]);

    const skipped = await call("POST", "actions/bulkSkip", {
      ids: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
    expect(skipped.status).toBe(201);
    expect(skipped.body.ids).toEqual([{ id: 1 }]);
  });

  it("ungated 'row' action and the id-addressed CRUD endpoints resolve the overlay too", async () => {
    const { call, table } = await boot();
    expect((await call("POST", "actions/approve", { ids: { id: 1 } })).status).toBe(201);
    expect((await call("POST", "actions/approve", { ids: { id: 3 } })).status).toBe(404);

    expect((await call("GET", "one/1")).status).toBe(200);
    expect((await call("GET", "one/3")).status).toBe(404);
    expect((await call("DELETE", "3")).status).toBe(404);
    expect((await call("DELETE", "1")).status).toBe(202);
    expect(await table.count({ filter: {} } as never)).toBe(2);
  });
});
