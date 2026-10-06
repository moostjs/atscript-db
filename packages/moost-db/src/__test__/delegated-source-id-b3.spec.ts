/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll } from "vite-plus/test";
import { createAdapter } from "@atscript/db-memory";
import { Post } from "@moostjs/event-http";
import { Inherit, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { AsDbReadableController } from "../as-db-readable.controller";
import { TableController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionsFrom } from "../actions/db-actions-from.decorator";
import { bootHttp, prepareFixtures } from "./test-utils";

/**
 * A `@DbActionsFrom` delegation answers for the RESOLVED id: every field of
 * every identification of the view counts as consumed, so a raw alias in any
 * of them (`?id=1&code=T-OLD`) never reaches the source's `resolveRowIds`.
 */

let FwTicket: any;
let FwIssue: any;
let RidTicket: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ FwTicket, FwIssue } = await import("./fixtures/fw3-actions.as"));
  ({ RidTicket } = await import("./fixtures/row-ids.as"));
});

async function boot() {
  getMoostInfact()._cleanup();
  const space = createAdapter();
  await space.getTable(FwTicket).insertMany([{ key: "T1", teamId: "a", status: "open" }] as never);
  const issues = space.getTable(FwIssue);
  await issues.insertMany([{ id: 1, ticketKey: "T1", status: "open", title: "one" }] as never);
  const tickets = space.getTable(RidTicket);
  await tickets.insertMany([
    { id: 1, code: "T-NEW", tenant: "a", status: "open", hiddenKey: "h1" },
  ] as never);
  const sourceCalls: any[] = [];

  @TableController(issues, "b3src")
  @Inherit()
  class IssueCtrl extends AsDbController {
    resolveRowIds(ids: any[]) {
      sourceCalls.push(ids);
      return ids;
    }

    @Post("actions/close")
    @DbAction("close", { label: "Close" })
    close(@DbActionID() id: unknown) {
      return { id };
    }
  }

  @TableController(tickets, "b3view")
  @DbActionsFrom(() => IssueCtrl, { idMap: { id: "code" } })
  @Inherit()
  class BoardCtrl extends AsDbReadableController {
    resolveRowIds(ids: any[]) {
      return ids.map((id) =>
        typeof id === "object" && id.code === "T-OLD" ? { code: "T-NEW" } : id,
      );
    }
  }

  const http = await bootHttp(IssueCtrl, BoardCtrl);
  return {
    sourceCalls,
    get: (q: string) => http("GET", `/b3view/meta/actions${q}`) as Promise<any>,
  };
}

describe("delegated available actions: the source never sees a raw alias", () => {
  it("?code=T-OLD: the source gets the resolved T-NEW", async () => {
    const { sourceCalls, get } = await boot();
    const res = await get("?code=T-OLD");
    expect(res.status).toBe(200);
    expect(JSON.stringify(sourceCalls)).toContain("T-NEW");
    expect(JSON.stringify(sourceCalls)).not.toContain("T-OLD");
  });

  it.each(["?id=1&code=T-OLD", "?id=1&code=ANYTHING"])(
    "%s: a field of another identification is consumed too",
    async (query) => {
      const { sourceCalls, get } = await boot();
      const res = await get(query);
      expect(res.status).toBe(200);
      const seen = JSON.stringify(sourceCalls);
      expect(seen).not.toContain("T-OLD");
      expect(seen).not.toContain("ANYTHING");
    },
  );
});
