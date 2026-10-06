/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll } from "vite-plus/test";
import { createAdapter } from "@atscript/db-memory";
import { Post } from "@moostjs/event-http";
import { Inherit, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { DbActionRows } from "../actions/db-action-row.decorator";
import { DbActionTarget, useDbActionTarget } from "../actions/target";
import { bootHttp, prepareFixtures } from "./test-utils";

/**
 * Target summaries of runs with alias ids (`resolveRowIds`): every request id is
 * judged by its own request position — in bulk summaries, in an aborted
 * streamed run, and in `fail()` bookkeeping, with or without a rewritten id.
 */

let RidTicket: any;

const TICKETS = [
  { id: 1, code: "T-NEW", tenant: "a", status: "open", hiddenKey: "h1" },
  { id: 2, code: "T-B", tenant: "b", status: "open", hiddenKey: "h2" },
  { id: 3, code: "T-HOLD", tenant: "a", status: "open", hiddenKey: "h3" },
  { id: 4, code: "T-LOCK", tenant: "a", status: "open", hiddenKey: "h4" },
];

beforeAll(async () => {
  await prepareFixtures();
  ({ RidTicket } = await import("./fixtures/row-ids.as"));
});

let SEQ = 0;
type Hook = ((ids: any[]) => any[]) | undefined;

async function boot(
  hook: Hook,
  opts: { overlay?: object; throwFirst?: boolean; throwAt?: number } = {},
) {
  getMoostInfact()._cleanup();
  const tickets = createAdapter().getTable(RidTicket);
  await tickets.insertMany(structuredClone(TICKETS) as never);
  const prefix = `alias${++SEQ}`;

  @Inherit()
  class Base extends AsDbController {
    transformOne(filter: any) {
      return opts.overlay ? { ...filter, ...opts.overlay } : filter;
    }

    @Post("actions/manySum")
    @DbAction("manySum", {
      label: "Many sum",
      onDisabledRows: "skip",
      disabled: (rows: any[]) => rows.map((r) => (r.code === "T-LOCK" ? "locked" : false)),
    })
    manySum(@DbActionIDs() _ids: unknown) {
      return { summary: useDbActionTarget().summary() };
    }

    @Post("actions/manyRows")
    @DbAction("manyRows", {
      label: "Many rows",
      onDisabledRows: "skip",
      disabled: (rows: any[]) => rows.map((r) => (r.code === "T-LOCK" ? "locked" : false)),
    })
    manyRows(@DbActionRows() _rows: any[]) {
      return { summary: useDbActionTarget().summary() };
    }

    @Post("actions/targeted")
    @DbAction("targeted", { label: "Targeted", queryTarget: { batchSize: 1 } })
    async targeted(@DbActionTarget() target: any) {
      let n = 0;
      for await (const _batch of target.batches()) {
        if (opts.throwFirst && n === 0) throw new Error("boom");
        if (n++ === opts.throwAt) throw new Error("boom");
      }
      return target.summary();
    }

    @Post("actions/failer")
    @DbAction("failer", { label: "Failer" })
    async failer(@DbActionTarget() target: any) {
      for await (const batch of target.batches()) {
        for (const id of batch.ids) {
          if (id.code === "T-NEW") {
            target.fail(id, "nope");
            target.fail(id, "nope again");
          }
        }
      }
      return target.summary();
    }
  }

  let Ctrl: any;
  if (hook) {
    @TableController(tickets, prefix)
    @Inherit()
    class Hooked extends Base {
      resolveRowIds(ids: any[]) {
        return hook!(ids);
      }
    }
    Ctrl = Hooked;
  } else {
    @TableController(tickets, prefix)
    @Inherit()
    class Plain extends Base {}
    Ctrl = Plain;
  }
  const http = await bootHttp(Ctrl);
  return (path: string, body?: unknown) => http("POST", `/${prefix}/${path}`, body) as Promise<any>;
}

const c = (...codes: string[]) => codes.map((code) => ({ code }));
const aliasTo =
  (target: string): Hook =>
  (ids) =>
    ids.map((id) => (id.code.startsWith("ALIAS") ? { code: target } : id));

describe("bulk @DbActionIDs / @DbActionRows summaries with aliases", () => {
  const ids = c("ALIAS-1", "T-LOCK", "ALIAS-2", "MISS");

  it.each(["manySum", "manyRows"])(
    "%s: matched, processed and skipped per request id, in order",
    async (name) => {
      const send = await boot(aliasTo("T-NEW"));
      const res = await send(`actions/${name}`, { ids });
      expect(res.body.summary).toEqual({
        matched: 4,
        processed: 2,
        skipped: [{ id: { code: "T-LOCK" }, reason: "locked" }, { id: { code: "MISS" } }],
        failed: [],
      });
    },
  );
});

describe("an aborted streamed run judges each request id by its own position", () => {
  it("aliases + abort on the first batch look exactly like distinct rows", async () => {
    const send = await boot(aliasTo("T-NEW"), { throwFirst: true });
    const res = await send("actions/targeted", {
      ids: c("ALIAS-1", "T-HOLD", "ALIAS-2", "T-LOCK"),
    });
    expect(res.body).toMatchObject({
      matched: 4,
      processed: 0,
      skipped: [],
      failed: [
        { id: { code: "ALIAS-1" }, reason: "boom" },
        { id: { code: "T-HOLD" }, reason: "not run" },
        { id: { code: "ALIAS-2" }, reason: "not run" },
        { id: { code: "T-LOCK" }, reason: "not run" },
      ],
      aborted: { status: 500, message: "boom" },
    });
  });

  it("an alias after the abort point is not 'skipped' because its row was judged earlier", async () => {
    const aliased = await boot(aliasTo("T-B"), { overlay: { tenant: "a" }, throwFirst: true });
    const res = await aliased("actions/targeted", {
      ids: c("ALIAS-1", "T-NEW", "T-HOLD", "ALIAS-2"),
    });
    expect(res.body).toMatchObject({
      matched: 4,
      processed: 0,
      skipped: [{ id: { code: "ALIAS-1" } }],
      failed: [
        { id: { code: "T-NEW" }, reason: "boom" },
        { id: { code: "T-HOLD" }, reason: "not run" },
        { id: { code: "ALIAS-2" }, reason: "not run" },
      ],
    });
    // the same request over four distinct rows (T-B out of scope, MISSing last)
    const distinct = await boot(undefined, { overlay: { tenant: "a" }, throwFirst: true });
    const same = await distinct("actions/targeted", { ids: c("T-B", "T-NEW", "T-HOLD", "MISS") });
    expect(same.body.skipped).toEqual([{ id: { code: "T-B" } }]);
    expect(same.body.failed.map((f: any) => f.reason)).toEqual(["boom", "not run", "not run"]);
  });
});

describe("an abort on the LAST batch counts a later alias like distinct rows", () => {
  it("the alias after the failing last batch is 'not run', not processed", async () => {
    const aliased = await boot(aliasTo("T-NEW"), { throwAt: 1 });
    const res = await aliased("actions/targeted", { ids: c("ALIAS-1", "T-HOLD", "ALIAS-2") });
    expect(res.body).toMatchObject({
      matched: 3,
      processed: 1,
      failed: [
        { id: { code: "T-HOLD" }, reason: "boom" },
        { id: { code: "ALIAS-2" }, reason: "not run" },
      ],
      aborted: { status: 500, message: "boom" },
    });
    const distinct = await boot(undefined, { throwAt: 1 });
    const same = await distinct("actions/targeted", { ids: c("T-NEW", "T-HOLD", "T-LOCK") });
    expect(same.body.processed).toBe(1);
    expect(same.body.failed.map((f: any) => f.reason)).toEqual(["boom", "not run"]);
  });
});

describe("fail() bookkeeping", () => {
  it.each([
    ["no hook", undefined],
    ["an identity hook", ((ids: any[]) => ids) as Hook],
  ])("fail(id) twice counts once and keeps processed (%s)", async (_label, hook) => {
    const send = await boot(hook);
    const res = await send("actions/failer", { ids: c("T-NEW", "T-HOLD") });
    expect(res.body).toEqual({
      matched: 2,
      processed: 1,
      skipped: [],
      failed: [{ id: { code: "T-NEW" }, reason: "nope" }],
    });
  });

  it("with aliases: one failure is reported per request id, processed is the rest", async () => {
    const send = await boot(aliasTo("T-NEW"));
    const res = await send("actions/failer", { ids: c("ALIAS-1", "T-HOLD", "ALIAS-2") });
    expect(res.body).toEqual({
      matched: 3,
      processed: 1,
      skipped: [],
      failed: [
        { id: { code: "ALIAS-1" }, reason: "nope" },
        { id: { code: "ALIAS-2" }, reason: "nope" },
      ],
    });
  });
});
