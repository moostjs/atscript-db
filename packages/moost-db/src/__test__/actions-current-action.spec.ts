import { describe, it, expect } from "vite-plus/test";
import { current } from "@wooksjs/event-core";

import { readCurrentActionMeta } from "../actions/current-action";
import { bindController, runInActionCtx, setupActionMeta } from "./actions-test-utils";

/**
 * Direct coverage for the shared helper used by `id-cache.noTableError` and
 * `row-cache.readActionFieldSet`. The helper centralizes the
 * `useControllerContext → getMoostMate().read → meta[MOOST_DB_ACTION]` lookup
 * with try/catch tolerance for direct-wook test contexts (where no
 * controller is bound).
 */

describe("readCurrentActionMeta", () => {
  it("returns the action meta when called inside a controller context", async () => {
    class Ctrl {
      ship(): void {}
    }
    setupActionMeta(
      Ctrl,
      "ship",
      {
        name: "ship",
        opts: { label: "Ship", requiredFields: ["status"], disabled: () => [false] },
      },
      ["id"],
    );
    let meta: ReturnType<typeof readCurrentActionMeta>;
    await runInActionCtx('{"id":"a"}', () => {
      bindController(new Ctrl(), "ship");
      meta = readCurrentActionMeta(current());
    });
    expect(meta!).toBeDefined();
    expect(meta!.name).toBe("ship");
    expect(meta!.opts.requiredFields).toEqual(["status"]);
  });

  it("returns undefined when no controller is bound (direct-wook test context)", async () => {
    let meta: ReturnType<typeof readCurrentActionMeta>;
    await runInActionCtx('{"id":"a"}', () => {
      meta = readCurrentActionMeta(current());
    });
    expect(meta!).toBeUndefined();
  });

  it("returns undefined when the controller method has no @DbAction meta", async () => {
    class Ctrl {
      plain(): void {}
    }
    let meta: ReturnType<typeof readCurrentActionMeta>;
    await runInActionCtx('{"id":"a"}', () => {
      bindController(new Ctrl(), "plain");
      meta = readCurrentActionMeta(current());
    });
    expect(meta!).toBeUndefined();
  });
});
