import { describe, it, expect, vi } from "vite-plus/test";
import { current } from "@wooksjs/event-core";
import { HttpError } from "@moostjs/event-http";

import { ActionDisabledError } from "../actions/action-disabled-error";
import {
  buildGateInterceptor,
  buildThinInterceptor,
  type GateInterceptorOpts,
} from "../actions/gate-interceptor";
import { dbActionIdSlot, dbActionIdsSlot } from "../actions/id-cache";
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
  it("disabled truthy → throws ActionDisabledError with id from cached ID slot", async () => {
    const table = makeOpsTable([{ id: "a", status: "shipped" }]);
    class Ctrl {
      ship(): void {}
    }
    setupActionMeta(Ctrl, "ship", { name: "ship", opts: { disabled: () => [true] } }, ["id"]);
    const def = buildGateInterceptor({
      action: "ship",
      level: "row",
      disabled: (rows: unknown[]) =>
        rows.map((row) => (row as { status: string }).status !== "processing"),
      onDisabledRows: "reject",
    });

    let caught: unknown;
    await runInActionCtx('{"id":"a"}', async () => {
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
    expect(((caught as ActionDisabledError).body as { id?: unknown }).id).toEqual({ id: "a" });
  });

  it("disabled falsy → handler proceeds; row is fetched exactly once and shared", async () => {
    const table = makeOpsTable([{ id: "a", status: "processing" }]);
    class Ctrl {
      ship(): void {}
    }
    setupActionMeta(Ctrl, "ship", { name: "ship", opts: { disabled: () => [false] } }, ["id"]);
    const def = buildGateInterceptor({
      action: "ship",
      level: "row",
      disabled: (rows: unknown[]) =>
        rows.map((row) => (row as { status: string }).status !== "processing"),
      onDisabledRows: "reject",
    });

    await runInActionCtx('{"id":"a"}', async () => {
      bindController(new Ctrl(), "ship");
      setBoundTable(table);
      await runBeforeInterceptor(def);
      expect(table.findOne).toHaveBeenCalledTimes(1);
      const arg = table.findOne.mock.calls[0][0] as {
        filter: unknown;
        controls: { $select: string[] };
      };
      expect(arg.filter).toEqual({ id: "a" });
      expect(new Set(arg.controls.$select)).toEqual(new Set(["id"]));
      const ctx = current();
      const row1 = await ctx.get(dbActionRowSlot);
      const row2 = await ctx.get(dbActionRowSlot);
      expect(row1).toBe(row2);
      expect(table.findOne).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Thin interceptor — bound-table injection only", () => {
  it("populates boundTableKey from opts.table; predicate is never invoked; row fetched lazily by param resolver", async () => {
    const table = makeOpsTable([{ id: "a", status: "processing" }]);
    const predicate = vi.fn().mockReturnValue(false);
    const thin = buildThinInterceptor({ table });

    await runInActionCtx('{"id":"a"}', async () => {
      class Ctrl {
        ship(): void {}
      }
      bindController(new Ctrl(), "ship");
      const ctx = current();
      await runBeforeInterceptor(thin);
      expect(predicate).not.toHaveBeenCalled();
      expect(table.findOne).not.toHaveBeenCalled();
      await ctx.get(dbActionIdSlot);
      const row = await ctx.get(dbActionRowSlot);
      expect(row).toEqual({ id: "a", status: "processing" });
      expect(table.findOne).toHaveBeenCalledTimes(1);
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
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["ids"]);

    const predicate = vi.fn((rowsArg: unknown[]) =>
      rowsArg.map((row) => (row as { archived: boolean }).archived),
    );
    const def = buildGateInterceptor({
      action: "archive",
      level: "rows",
      disabled: predicate as (rows: unknown[]) => boolean[],
      onDisabledRows: "reject",
    });

    let caught: unknown;
    await runInActionCtx('[{"id":"1"},{"id":"2"},{"id":"3"}]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      try {
        await runBeforeInterceptor(def);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ActionDisabledError);
    expect(predicate).toHaveBeenCalledTimes(1);
    const body = (caught as ActionDisabledError).body as { ids?: unknown[] };
    expect(body.ids).toEqual([{ id: "2" }, { id: "3" }]);
  });
});

describe("Gate interceptor — rows-level skip mode", () => {
  it("filters cached rows + cached IDs to passing-only", async () => {
    const rows = [
      { id: "1", archived: false },
      { id: "2", archived: true },
      { id: "3", archived: false },
    ];
    const table = makeOpsTable(rows);
    class Ctrl {
      archive(): void {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["ids"]);

    const def = buildGateInterceptor({
      action: "archive",
      level: "rows",
      disabled: (rowsArg: unknown[]) =>
        rowsArg.map((row) => (row as { archived: boolean }).archived),
      onDisabledRows: "skip",
    });

    await runInActionCtx('[{"id":"1"},{"id":"2"},{"id":"3"}]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      const ctx = current();
      await runBeforeInterceptor(def);
      const filteredRows = (await ctx.get(dbActionRowsSlot)) as Array<{ id: string }>;
      const filteredIds = (await ctx.get(dbActionIdsSlot)) as unknown[];
      expect(filteredRows).toHaveLength(2);
      expect(filteredRows.map((r) => r.id)).toEqual(["1", "3"]);
      expect(filteredIds).toEqual([{ id: "1" }, { id: "3" }]);
    });
  });

  it("zero survivors → throws ActionDisabledError with ALL request IDs", async () => {
    const rows = [
      { id: "1", archived: true },
      { id: "2", archived: true },
    ];
    const table = makeOpsTable(rows);
    class Ctrl {
      archive(): void {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["ids"]);

    const def = buildGateInterceptor({
      action: "archive",
      level: "rows",
      disabled: (rowsArg: unknown[]) =>
        rowsArg.map((row) => (row as { archived: boolean }).archived),
      onDisabledRows: "skip",
    });

    let caught: unknown;
    await runInActionCtx('[{"id":"1"},{"id":"2"}]', async () => {
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
    expect(body.ids).toEqual([{ id: "1" }, { id: "2" }]);
  });
});

describe("Gate interceptor — missing-row handling", () => {
  it("reject mode: predicate is invoked only with existing rows; missing-row id is added to failingIds", async () => {
    // Row 2 is absent from the table — the gate must NOT pass undefined into the predicate.
    const table = makeOpsTable([{ id: "1", archived: false }]);
    class Ctrl {
      archive(): void {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["ids"]);

    const predicate = vi.fn((rowsArg: unknown[]) =>
      rowsArg.map((row) => (row as { archived: boolean }).archived),
    );
    const def = buildGateInterceptor({
      action: "archive",
      level: "rows",
      disabled: predicate as (rows: unknown[]) => boolean[],
      onDisabledRows: "reject",
    });

    let caught: unknown;
    await runInActionCtx('[{"id":"1"},{"id":"2"}]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      try {
        await runBeforeInterceptor(def);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ActionDisabledError);
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(predicate.mock.calls[0][0]).toEqual([{ id: "1", archived: false }]);
    const body = (caught as ActionDisabledError).body as { ids?: unknown[] };
    expect(body.ids).toEqual([{ id: "2" }]);
  });

  it("reject mode: preserves request order across mixed missing-row + predicate-rejected failures", async () => {
    // Row 2 missing; predicate rejects rows 1 and 3. Expect failing ids in
    // request order — NOT grouped by failure type.
    const table = makeOpsTable([
      { id: "1", archived: true },
      { id: "3", archived: true },
    ]);
    class Ctrl {
      archive(): void {}
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
    await runInActionCtx('[{"id":"1"},{"id":"2"},{"id":"3"}]', async () => {
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
    expect(body.ids).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
  });

  it("skip mode: drops missing-row identifiers from both survivor arrays", async () => {
    // Row 2 missing; predicate passes for rows 1 and 3. Survivors must be
    // [{id:"1"}, {id:"3"}] — the missing id MUST NOT appear in survivors.
    const table = makeOpsTable([
      { id: "1", archived: false },
      { id: "3", archived: false },
    ]);
    class Ctrl {
      archive(): void {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["ids"]);

    const def = buildGateInterceptor({
      action: "archive",
      level: "rows",
      disabled: (rowsArg: unknown[]) =>
        rowsArg.map((row) => (row as { archived: boolean }).archived),
      onDisabledRows: "skip",
    });

    await runInActionCtx('[{"id":"1"},{"id":"2"},{"id":"3"}]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      const ctx = current();
      await runBeforeInterceptor(def);
      const filteredRows = (await ctx.get(dbActionRowsSlot)) as Array<{ id: string }>;
      const filteredIds = (await ctx.get(dbActionIdsSlot)) as unknown[];
      expect(filteredRows.map((r) => r.id)).toEqual(["1", "3"]);
      expect(filteredIds).toEqual([{ id: "1" }, { id: "3" }]);
    });
  });
});

describe("Gate interceptor — verdict-array invariant", () => {
  it("predicate returning the wrong-length array throws HttpError(500) identifying the action", async () => {
    // Buggy predicate returns one verdict for a 3-row input. Gate has no
    // safe assignment of verdicts to rows, so the request fails fast.
    const table = makeOpsTable([
      { id: "1", archived: false },
      { id: "2", archived: false },
      { id: "3", archived: false },
    ]);
    class Ctrl {
      archive(): void {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["ids"]);

    const def = buildGateInterceptor({
      action: "archive",
      level: "rows",
      disabled: () => [true],
      onDisabledRows: "reject",
    });

    let caught: unknown;
    await runInActionCtx('[{"id":"1"},{"id":"2"},{"id":"3"}]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      try {
        await runBeforeInterceptor(def);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).body.statusCode).toBe(500);
    expect(String((caught as HttpError).body.message)).toContain("archive");
  });
});

describe("Gate interceptor — type contract", () => {
  it("rejects async disabled predicates at the TS type level", () => {
    // Type-only assertion — the runtime test is a no-op; the value below
    // is intentionally never invoked. The `@ts-expect-error` is the test:
    // if the predicate type silently widens to allow `Promise<boolean[]>`,
    // the type-checker stops emitting an error and `vp check` fails.
    const _opts: GateInterceptorOpts = {
      action: "noop",
      level: "rows",
      // @ts-expect-error async (Promise<boolean[]>) is not assignable to (rows) => boolean[]
      disabled: async (_rows: unknown[]) => [false],
      onDisabledRows: "reject",
    };
    expect(_opts).toBeDefined();
  });
});
