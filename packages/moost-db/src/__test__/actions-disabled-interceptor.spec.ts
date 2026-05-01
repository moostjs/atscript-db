import { describe, it, expect, vi } from "vite-plus/test";
import { current } from "@wooksjs/event-core";

import { ActionDisabledError } from "../actions/action-disabled-error";
import { buildGateInterceptor, buildThinInterceptor } from "../actions/gate-interceptor";
import { dbActionPkSlot, dbActionPksSlot } from "../actions/pk-cache";
import { dbActionRowSlot, dbActionRowsSlot } from "../actions/row-cache";
import {
  bindController,
  makeOpsTable,
  runBeforeInterceptor,
  runInActionCtx,
  setBoundTable,
  setupActionMeta,
} from "./actions-test-utils";

/**
 * Coverage for the gate interceptor's runtime behaviour. We invoke the
 * interceptor's `before` callback directly inside a real event context so
 * we can assert table-injection, row-fetch, predicate-eval, and
 * skip-mode mutation without spinning up a full Moost HTTP runtime.
 */

describe("Gate interceptor — row-level", () => {
  it("disabled truthy → throws ActionDisabledError with pk from cached PK slot", async () => {
    const table = makeOpsTable([{ id: "a", status: "shipped" }]);
    class Ctrl {
      ship(): void {}
    }
    setupActionMeta(Ctrl, "ship", { name: "ship", opts: { disabled: () => true } }, ["pk"]);
    const def = buildGateInterceptor({
      action: "ship",
      level: "row",
      disabled: (row: unknown) => (row as { status: string }).status !== "processing",
      onDisabledRows: "reject",
    });

    let caught: unknown;
    await runInActionCtx('"a"', async () => {
      bindController(new Ctrl(), "ship");
      setBoundTable(table);
      try {
        await runBeforeInterceptor(def);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ActionDisabledError);
    expect((caught as ActionDisabledError).body.statusCode).toBe(409);
    expect(((caught as ActionDisabledError).body as { pk?: unknown }).pk).toBe("a");
  });

  it("disabled falsy → handler proceeds; row is fetched exactly once and shared", async () => {
    const table = makeOpsTable([{ id: "a", status: "processing" }]);
    class Ctrl {
      ship(): void {}
    }
    setupActionMeta(Ctrl, "ship", { name: "ship", opts: { disabled: () => false } }, ["pk"]);
    const def = buildGateInterceptor({
      action: "ship",
      level: "row",
      disabled: (row: unknown) => (row as { status: string }).status !== "processing",
      onDisabledRows: "reject",
    });

    await runInActionCtx('"a"', async () => {
      bindController(new Ctrl(), "ship");
      setBoundTable(table);
      await runBeforeInterceptor(def);
      expect(table.findById).toHaveBeenCalledTimes(1);
      expect(table.findById).toHaveBeenCalledWith("a");
      const ctx = current();
      const row1 = await ctx.get(dbActionRowSlot);
      const row2 = await ctx.get(dbActionRowSlot);
      expect(row1).toBe(row2);
      expect(table.findById).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Thin interceptor — bound-table injection only", () => {
  it("populates boundTableKey from opts.table; predicate is never invoked; row fetched lazily by param resolver", async () => {
    const table = makeOpsTable([{ id: "a", status: "processing" }]);
    const predicate = vi.fn().mockReturnValue(false);
    const thin = buildThinInterceptor({ table });

    await runInActionCtx('"a"', async () => {
      class Ctrl {
        ship(): void {}
      }
      bindController(new Ctrl(), "ship");
      const ctx = current();
      await runBeforeInterceptor(thin);
      expect(predicate).not.toHaveBeenCalled();
      expect(table.findById).not.toHaveBeenCalled();
      await ctx.get(dbActionPkSlot);
      const row = await ctx.get(dbActionRowSlot);
      expect(row).toEqual({ id: "a", status: "processing" });
      expect(table.findById).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Gate interceptor — rows-level reject mode (full scan)", () => {
  it("evaluates disabled for ALL rows even when an early row fails (full scan, not short-circuit)", async () => {
    const rows = [
      { id: "1", archived: false },
      { id: "2", archived: true },
      { id: "3", archived: true },
    ];
    const table = makeOpsTable(rows);
    class Ctrl {
      archive(): void {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["pks"]);

    const predicate = vi.fn((row: unknown) => (row as { archived: boolean }).archived);
    const def = buildGateInterceptor({
      action: "archive",
      level: "rows",
      disabled: predicate as (row: unknown) => boolean,
      onDisabledRows: "reject",
    });

    let caught: unknown;
    await runInActionCtx('["1","2","3"]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      try {
        await runBeforeInterceptor(def);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ActionDisabledError);
    expect(predicate).toHaveBeenCalledTimes(3); // FULL scan
    const body = (caught as ActionDisabledError).body as { pks?: unknown[] };
    expect(body.pks).toEqual(["2", "3"]);
  });
});

describe("Gate interceptor — rows-level skip mode", () => {
  it("filters cached rows + cached PKs to passing-only", async () => {
    const rows = [
      { id: "1", archived: false },
      { id: "2", archived: true },
      { id: "3", archived: false },
    ];
    const table = makeOpsTable(rows);
    class Ctrl {
      archive(): void {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["pks"]);

    const def = buildGateInterceptor({
      action: "archive",
      level: "rows",
      disabled: (row: unknown) => (row as { archived: boolean }).archived,
      onDisabledRows: "skip",
    });

    await runInActionCtx('["1","2","3"]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      const ctx = current();
      await runBeforeInterceptor(def);
      const filteredRows = (await ctx.get(dbActionRowsSlot)) as Array<{ id: string }>;
      const filteredPks = (await ctx.get(dbActionPksSlot)) as unknown[];
      expect(filteredRows).toHaveLength(2);
      expect(filteredRows.map((r) => r.id)).toEqual(["1", "3"]);
      expect(filteredPks).toEqual(["1", "3"]);
    });
  });

  it("zero survivors → throws ActionDisabledError with ALL request PKs", async () => {
    const rows = [
      { id: "1", archived: true },
      { id: "2", archived: true },
    ];
    const table = makeOpsTable(rows);
    class Ctrl {
      archive(): void {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["pks"]);

    const def = buildGateInterceptor({
      action: "archive",
      level: "rows",
      disabled: (row: unknown) => (row as { archived: boolean }).archived,
      onDisabledRows: "skip",
    });

    let caught: unknown;
    await runInActionCtx('["1","2"]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      try {
        await runBeforeInterceptor(def);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ActionDisabledError);
    const body = (caught as ActionDisabledError).body as { pks?: unknown[] };
    expect(body.pks).toEqual(["1", "2"]);
  });
});
