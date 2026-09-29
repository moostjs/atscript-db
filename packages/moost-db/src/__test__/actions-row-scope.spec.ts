/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vite-plus/test";
import type { FilterExpr } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { MoostHttp, Post } from "@moostjs/event-http";
import { Inherit, Moost, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { DbActionRow, DbActionRows } from "../actions/db-action-row.decorator";
import { prepareFixtures } from "./test-utils";

/**
 * Action ids / rows obey the controller's row overlay (since 0.1.143): an id
 * outside `transformOne({})` is indistinguishable from a missing one — the
 * same 404 on `'row'` actions, the same `ids` / `reasons` slot on `'rows'`
 * actions — and the handler never runs for it. `requiredFields` hidden by
 * `hasField` are never loaded. End-to-end through `MoostHttp.request()`.
 */

let ScopeAct: any;

const SEED = [
  { id: 1, owner: "u1", status: "open", secret: "s1", meta: { tag: "t1" } },
  { id: 2, owner: "u2", status: "locked", secret: "s2" },
  { id: 3, owner: "u2", status: "open", secret: "s3" },
  { id: 4, owner: "u1", status: "open", secret: "LOCKME" },
];

const locked = (rows: Array<{ status: string }>) =>
  rows.map((r) => (r.status === "locked" ? `Row is locked (status=${r.status})` : false));

let handlerCalls: Array<{ action: string; arg: unknown }> = [];

function defineBase() {
  @Inherit()
  class ActsBase extends AsDbController {
    @Post("actions/approve")
    @DbAction("approve", { label: "approve" })
    approve(@DbActionID() id: { id: number }) {
      handlerCalls.push({ action: "approve", arg: id });
      return { id };
    }

    @Post("actions/peek")
    @DbAction("peek", { label: "peek", requiredFields: ["owner", "status", "secret"] })
    peek(@DbActionRow() row: unknown) {
      return { row };
    }

    @Post("actions/peekTag")
    @DbAction("peekTag", { label: "peekTag", requiredFields: ["owner", "tagCopy"] })
    peekTag(@DbActionRow() row: unknown) {
      return { row };
    }

    @Post("actions/gated")
    @DbAction("gated", { label: "gated", requiredFields: ["status"], disabled: locked })
    gated(@DbActionRow() row: unknown) {
      return { row };
    }

    @Post("actions/gatedSecret")
    @DbAction("gatedSecret", {
      label: "gatedSecret",
      requiredFields: ["secret"],
      disabled: (rows: Array<{ secret?: string }>) =>
        rows.map((r) => (r.secret === "LOCKME" ? `blocked: secret=${r.secret}` : false)),
    })
    gatedSecret(@DbActionRow() row: unknown) {
      return { row };
    }

    @Post("actions/bulk")
    @DbAction("bulk", { label: "bulk", requiredFields: ["owner", "secret"] })
    bulk(@DbActionIDs() ids: unknown, @DbActionRows() rows: unknown) {
      handlerCalls.push({ action: "bulk", arg: ids });
      return { ids, rows };
    }

    @Post("actions/bulkIds")
    @DbAction("bulkIds", { label: "bulkIds", maxIds: 3 })
    bulkIds(@DbActionIDs() ids: unknown) {
      handlerCalls.push({ action: "bulkIds", arg: ids });
      return { ids };
    }

    @Post("actions/bulkGated")
    @DbAction("bulkGated", { label: "bulkGated", requiredFields: ["status"], disabled: locked })
    bulkGated(@DbActionRows() rows: unknown) {
      return { rows };
    }

    @Post("actions/bulkSkip")
    @DbAction("bulkSkip", {
      label: "bulkSkip",
      requiredFields: ["status"],
      disabled: locked,
      onDisabledRows: "skip",
    })
    bulkSkip(@DbActionIDs() ids: unknown, @DbActionRows() rows: unknown) {
      return { ids, rows };
    }
  }
  return ActsBase;
}

type Res = { status: number; body: any };

// A distinct route prefix per boot avoids router re-registration warnings.
let PREFIX_SEQ = 0;

async function boot(scoped: boolean) {
  getMoostInfact()._cleanup();
  const space = createAdapter();
  const table = space.getTable(ScopeAct);
  await table.insertMany(structuredClone(SEED));
  const Base = defineBase();
  const prefix = `acts${++PREFIX_SEQ}`;

  let Ctrl: Function;
  if (scoped) {
    @TableController(table, prefix)
    class ScopedActs extends Base {
      protected override transformFilter(filter: FilterExpr): FilterExpr {
        return { $and: [filter, { owner: "u1" }] } as FilterExpr;
      }
      protected override hasField(path: string): boolean {
        return path !== "secret" && path.split(".")[0] !== "meta" && super.hasField(path);
      }
    }
    Ctrl = ScopedActs;
  } else {
    @TableController(table, prefix)
    class PlainActs extends Base {}
    Ctrl = PlainActs;
  }

  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(Ctrl);
  await app.init();
  const call = async (path: string, body?: unknown): Promise<Res> => {
    const res = await http.request(`/${prefix}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res!.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res!.status, body: parsed };
  };
  return { call, table };
}

beforeAll(async () => {
  await prepareFixtures();
  ({ ScopeAct } = await import("./fixtures/action-scope.as"));
});

beforeEach(() => {
  handlerCalls = [];
});

describe("'row' actions under a row overlay", () => {
  it("id-only handler: an out-of-scope id gets the SAME 404 as a missing one; the handler never runs", async () => {
    const { call } = await boot(true);
    const missing = await call("actions/approve", { ids: { id: 99 } });
    const foreign = await call("actions/approve", { ids: { id: 3 } });
    expect(missing.status).toBe(404);
    expect(foreign).toEqual(missing);
    expect(foreign.body.message).toBe("Row not found for action identifier");
    expect(handlerCalls).toEqual([]);

    const own = await call("actions/approve", { ids: { id: 1 } });
    expect(own.status).toBe(201);
    expect(handlerCalls).toEqual([{ action: "approve", arg: { id: 1 } }]);
  });

  it("@DbActionRow: out-of-scope → 404; an in-scope row never carries a hasField-hidden requiredField", async () => {
    const { call } = await boot(true);
    const missing = await call("actions/peek", { ids: { id: 99 } });
    expect(await call("actions/peek", { ids: { id: 3 } })).toEqual(missing);
    const own = await call("actions/peek", { ids: { id: 4 } });
    expect(own.status).toBe(201);
    expect(own.body.row).toEqual({ id: 4, owner: "u1", status: "open" });
  });

  it("@DbActionRow: a derived requiredField over a hidden source is never loaded", async () => {
    const scoped = await boot(true);
    expect((await scoped.call("actions/peekTag", { ids: { id: 1 } })).body.row).toEqual({
      id: 1,
      owner: "u1",
    });
    const plain = await boot(false);
    expect((await plain.call("actions/peekTag", { ids: { id: 1 } })).body.row).toEqual({
      id: 1,
      owner: "u1",
      tagCopy: "t1",
    });
  });

  it("gate: an out-of-scope LOCKED row is a plain 404 — no 409, no reason", async () => {
    const { call } = await boot(true);
    const missing = await call("actions/gated", { ids: { id: 99 } });
    const lockedForeign = await call("actions/gated", { ids: { id: 2 } });
    const openForeign = await call("actions/gated", { ids: { id: 3 } });
    expect(missing.status).toBe(404);
    expect(lockedForeign).toEqual(missing);
    expect(openForeign).toEqual(missing);
  });

  it("gate: a disabled predicate over a hidden requiredField sees undefined (no verdict oracle)", async () => {
    const { call } = await boot(true);
    const res = await call("actions/gatedSecret", { ids: { id: 4 } });
    expect(res.status).toBe(201);
    expect(res.body.row).toEqual({ id: 4 });
  });
});

describe("'rows' actions under a row overlay", () => {
  it("ungated: out-of-scope and missing ids fail alike (reject, null reasons); the handler never runs", async () => {
    const { call } = await boot(true);
    const res = await call("actions/bulk", { ids: [{ id: 1 }, { id: 3 }, { id: 99 }] });
    expect(res.status).toBe(409);
    expect(res.body.ids).toEqual([{ id: 3 }, { id: 99 }]);
    expect(res.body).not.toHaveProperty("reasons");
    expect(res.body).not.toHaveProperty("reason");
    expect(handlerCalls).toEqual([]);
  });

  it("id-only handler: verified too", async () => {
    const { call } = await boot(true);
    const bad = await call("actions/bulkIds", { ids: [{ id: 3 }, { id: 1 }] });
    expect(bad.status).toBe(409);
    expect(bad.body.ids).toEqual([{ id: 3 }]);
    const ok = await call("actions/bulkIds", { ids: [{ id: 1 }, { id: 4 }] });
    expect(ok.status).toBe(201);
    expect(handlerCalls).toEqual([{ action: "bulkIds", arg: [{ id: 1 }, { id: 4 }] }]);
  });

  it("in-scope rows never carry a hasField-hidden requiredField", async () => {
    const { call } = await boot(true);
    const res = await call("actions/bulk", { ids: [{ id: 1 }, { id: 4 }] });
    expect(res.status).toBe(201);
    expect(res.body.rows).toEqual([
      { id: 1, owner: "u1" },
      { id: 4, owner: "u1" },
    ]);
  });

  it("gate reject: a foreign LOCKED row's reason is never disclosed — same slot as a missing id", async () => {
    const { call } = await boot(true);
    const res = await call("actions/bulkGated", {
      ids: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 99 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.ids).toEqual([{ id: 2 }, { id: 3 }, { id: 99 }]);
    expect(res.body).not.toHaveProperty("reasons");
    expect(res.body.message).not.toContain("locked");
  });

  it("gate skip: out-of-scope rows are dropped like missing ones; zero survivors → 409 with every id", async () => {
    const { call } = await boot(true);
    const res = await call("actions/bulkSkip", { ids: [{ id: 1 }, { id: 3 }, { id: 99 }] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ids: [{ id: 1 }], rows: [{ id: 1, status: "open" }] });
    const none = await call("actions/bulkSkip", { ids: [{ id: 2 }, { id: 99 }] });
    expect(none.status).toBe(409);
    expect(none.body.ids).toEqual([{ id: 2 }, { id: 99 }]);
    expect(none.body).not.toHaveProperty("reasons");
  });
});

describe("id-count cap", () => {
  it("rejects more ids than opts.maxIds with 400 before any row is loaded", async () => {
    const { call, table } = await boot(true);
    const findMany = vi.spyOn(table, "findMany");
    const res = await call("actions/bulkIds", {
      ids: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("Too many identifiers: 4 (at most 3 per request)");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("defaults to 1000", async () => {
    const { call } = await boot(false);
    const ids = Array.from({ length: 1001 }, (_, i) => ({ id: i + 1 }));
    const res = await call("actions/bulk", { ids });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("at most 1000 per request");
    expect((await call("actions/bulk", { ids: ids.slice(0, 1000) })).status).toBe(201);
  });
});

describe("no overlay (transformOne / transformFilter not overridden)", () => {
  it("costs nothing: id-only handlers run with no extra query, rows keep missing-id gaps", async () => {
    const { call, table } = await boot(false);
    const count = vi.spyOn(table, "count");
    const findOne = vi.spyOn(table, "findOne");
    const findMany = vi.spyOn(table, "findMany");
    expect((await call("actions/approve", { ids: { id: 3 } })).status).toBe(201);
    expect((await call("actions/bulkIds", { ids: [{ id: 3 }, { id: 99 }] })).status).toBe(201);
    expect(count).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();

    const res = await call("actions/bulk", { ids: [{ id: 3 }, { id: 99 }] });
    expect(res.status).toBe(201);
    expect(res.body.rows).toEqual([{ id: 3, owner: "u2", secret: "s3" }, null]);
  });
});
