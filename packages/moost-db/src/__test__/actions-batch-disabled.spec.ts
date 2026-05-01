import { describe, it, expect, vi } from "vite-plus/test";
import { current } from "@wooksjs/event-core";
import { HttpError } from "@moostjs/event-http";

import { ActionDisabledError } from "../actions/action-disabled-error";
import { buildGateInterceptor } from "../actions/gate-interceptor";
import { dbActionIdsSlot } from "../actions/id-cache";
import { dbActionRowsSlot } from "../actions/row-cache";
import { perRow } from "../actions/per-row";
import type { DbActionOpts } from "../actions/types";
import {
  bindController,
  makeOpsTable,
  runBeforeInterceptor,
  runInActionCtx,
  setBoundTable,
  setupActionMeta,
} from "./actions-test-utils";

/**
 * `disabled` predicate batch-shape contract — sync function, parallel
 * `boolean[]` aligned with input. Cross-cuts the gate interceptor and the
 * shape spec; the augmenter's batch-shape coverage lives in
 * `actions-list-augmenter.spec.ts`.
 */

describe("disabled — batch-shape invocation contract", () => {
  it("'row' level: predicate invoked exactly once with a 1-element array", async () => {
    const table = makeOpsTable([{ id: "a", status: "processing" }]);
    class Ctrl {
      ship(): void {}
    }
    setupActionMeta(Ctrl, "ship", { name: "ship" }, ["id"]);

    const predicate = vi.fn((rows: unknown[]) =>
      rows.map((row) => (row as { status: string }).status === "shipped"),
    );

    await runInActionCtx('{"id":"a"}', async () => {
      bindController(new Ctrl(), "ship");
      setBoundTable(table);
      await runBeforeInterceptor(
        buildGateInterceptor({
          action: "ship",
          level: "row",
          disabled: predicate as (rows: unknown[]) => boolean[],
          onDisabledRows: "reject",
        }),
      );
    });

    expect(predicate).toHaveBeenCalledTimes(1);
    expect(predicate.mock.calls[0][0]).toHaveLength(1);
    expect(predicate.mock.calls[0][0]).toEqual([{ id: "a", status: "processing" }]);
  });

  it("'rows' level reject: full scan with all surviving rows in one batch call", async () => {
    const table = makeOpsTable([
      { id: "1", archived: false },
      { id: "2", archived: true },
      { id: "3", archived: false },
    ]);
    class Ctrl {
      archive(): void {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["ids"]);

    const predicate = vi.fn((rows: unknown[]) =>
      rows.map((row) => (row as { archived: boolean }).archived),
    );

    let caught: unknown;
    await runInActionCtx('[{"id":"1"},{"id":"2"},{"id":"3"}]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      try {
        await runBeforeInterceptor(
          buildGateInterceptor({
            action: "archive",
            level: "rows",
            disabled: predicate as (rows: unknown[]) => boolean[],
            onDisabledRows: "reject",
          }),
        );
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(ActionDisabledError);
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(predicate.mock.calls[0][0]).toHaveLength(3);
  });

  it("'rows' level skip: predicate runs once; survivors are filtered into the cached row + id slots", async () => {
    const table = makeOpsTable([
      { id: "1", archived: false },
      { id: "2", archived: true },
      { id: "3", archived: false },
    ]);
    class Ctrl {
      archive(): void {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["ids"]);

    const predicate = vi.fn((rows: unknown[]) =>
      rows.map((row) => (row as { archived: boolean }).archived),
    );

    await runInActionCtx('[{"id":"1"},{"id":"2"},{"id":"3"}]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      const ctx = current();
      await runBeforeInterceptor(
        buildGateInterceptor({
          action: "archive",
          level: "rows",
          disabled: predicate as (rows: unknown[]) => boolean[],
          onDisabledRows: "skip",
        }),
      );
      const survivors = (await ctx.get(dbActionRowsSlot)) as Array<{ id: string }>;
      const survivorIds = (await ctx.get(dbActionIdsSlot)) as unknown[];
      expect(predicate).toHaveBeenCalledTimes(1);
      expect(survivors.map((r) => r.id)).toEqual(["1", "3"]);
      expect(survivorIds).toEqual([{ id: "1" }, { id: "3" }]);
    });
  });

  it("length mismatch surfaces HTTP 500 with the action name", async () => {
    const table = makeOpsTable([
      { id: "1", archived: false },
      { id: "2", archived: false },
    ]);
    class Ctrl {
      archive(): void {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive" }, ["ids"]);

    let caught: unknown;
    await runInActionCtx('[{"id":"1"},{"id":"2"}]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      try {
        await runBeforeInterceptor(
          buildGateInterceptor({
            action: "archive",
            level: "rows",
            disabled: () => [false],
            onDisabledRows: "reject",
          }),
        );
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).body.statusCode).toBe(500);
    expect(String((caught as HttpError).body.message)).toContain("archive");
  });
});

describe("disabled — type-level constraints", () => {
  it("async predicate is not assignable to DbActionOpts.disabled", () => {
    const _opts: DbActionOpts<{ flagged: boolean }> = {
      // @ts-expect-error async (Promise<boolean[]>) is not assignable to (rows) => boolean[]
      disabled: async (rows: { flagged: boolean }[]) => rows.map((r) => r.flagged),
    };
    expect(_opts).toBeDefined();
  });
});

describe("perRow helper", () => {
  it("lifts a per-row predicate into the batch shape, preserving polarity", () => {
    const lifted = perRow<{ status: string }>((r) => r.status === "archived");
    expect(lifted([{ status: "archived" }, { status: "open" }, { status: "archived" }])).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("lifted fn is sync and returns an array of the same length as the input", () => {
    const lifted = perRow<{ flagged: boolean }>((r) => r.flagged);
    const out = lifted([]);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(0);
  });
});
