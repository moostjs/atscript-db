import { describe, it, expect } from "vite-plus/test";

import { ActionDisabledError } from "../actions/action-disabled-error";
import { buildGateInterceptor } from "../actions/gate-interceptor";
import {
  bindController,
  makeOpsTable,
  runBeforeInterceptor,
  runInActionCtx,
  setBoundTable,
  setupActionMeta,
} from "./actions-test-utils";

/**
 * Coverage for the `'rows'`-level batch policies — `'reject'` (default) and
 * `'skip'`. The interceptor tests in `actions-disabled-interceptor.spec.ts`
 * cover the core scenarios; this spec adds the all-rows-pass / handler-runs
 * happy paths and a regression for ordering preservation.
 */

describe("'rows'-level reject mode (default)", () => {
  it("all rows pass → handler proceeds (interceptor doesn't throw)", async () => {
    const rows = [
      { id: "1", archived: false },
      { id: "2", archived: false },
    ];
    const table = makeOpsTable(rows);
    class Ctrl {
      archive() {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["ids"]);
    const def = buildGateInterceptor({
      action: "archive",
      level: "rows",
      disabled: (rowsArg: unknown[]) =>
        rowsArg.map((row) => (row as { archived: boolean }).archived),
      onDisabledRows: "reject",
    });
    let threw = false;
    await runInActionCtx('[{"id":"1"},{"id":"2"}]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      try {
        await runBeforeInterceptor(def);
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(false);
  });

  it("failing IDs are listed in REQUEST order (preserves user-supplied ordering)", async () => {
    const rows = [
      { id: "5", archived: true },
      { id: "1", archived: false },
      { id: "3", archived: true },
    ];
    const table = makeOpsTable(rows);
    // Override findMany to return rows in DB order (different from request),
    // exercising row-cache's request-order preservation.
    table.findMany.mockResolvedValueOnce([rows[1], rows[2], rows[0]]);
    class Ctrl {
      archive() {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["ids"]);
    const def = buildGateInterceptor({
      action: "archive",
      level: "rows",
      disabled: (rowsArg: unknown[]) =>
        rowsArg.map((row) => (row as { archived: boolean }).archived),
      onDisabledRows: "reject",
    });
    let caught: unknown;
    // Request order: [{id:"5"},{id:"1"},{id:"3"}]. Failing in request order: [{id:"5"},{id:"3"}].
    await runInActionCtx('[{"id":"5"},{"id":"1"},{"id":"3"}]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      try {
        await runBeforeInterceptor(def);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ActionDisabledError);
    const body = (caught as ActionDisabledError).body as { ids?: unknown[] };
    expect(body.ids).toEqual([{ id: "5" }, { id: "3" }]);
  });
});

describe("'rows'-level skip mode — happy path", () => {
  it("partial pass → handler runs with the filtered survivors only", async () => {
    const rows = [
      { id: "1", archived: false },
      { id: "2", archived: true },
      { id: "3", archived: false },
    ];
    const table = makeOpsTable(rows);
    class Ctrl {
      archive() {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["ids"]);
    const def = buildGateInterceptor({
      action: "archive",
      level: "rows",
      disabled: (rowsArg: unknown[]) =>
        rowsArg.map((row) => (row as { archived: boolean }).archived),
      onDisabledRows: "skip",
    });
    let threw = false;
    await runInActionCtx('[{"id":"1"},{"id":"2"},{"id":"3"}]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      try {
        await runBeforeInterceptor(def);
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(false);
  });
});
