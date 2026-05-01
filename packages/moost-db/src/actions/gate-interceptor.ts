import { current } from "@wooksjs/event-core";
import { HttpError } from "@moostjs/event-http";
import {
  defineBeforeInterceptor,
  TInterceptorPriority,
  useControllerContext,
  type TInterceptorDef,
} from "moost";

import { ActionDisabledError } from "./action-disabled-error";
import { isAsDbReadableControllerInstance } from "./controller-registry";
import { boundTableKey, dbActionIdSlot, dbActionIdsSlot } from "./id-cache";
import { dbActionRowSlot, dbActionRowsSlot } from "./row-cache";
import type { TOnDisabledRows } from "./types";

const GATE_PRIORITY = TInterceptorPriority.AFTER_GUARD;

function injectBoundTable(table: unknown): void {
  const ctx = current();
  if (ctx.has(boundTableKey)) return;
  const controller = useControllerContext(ctx).getController();
  if (isAsDbReadableControllerInstance(controller)) {
    // Bound-table controller wins over opts.table (spec contract).
    ctx.set(boundTableKey, (controller as { readable?: unknown }).readable);
    return;
  }
  if (table != null) {
    ctx.set(boundTableKey, table);
  }
}

export interface GateInterceptorOpts {
  action: string;
  level: "row" | "rows";
  disabled: (rows: unknown[]) => boolean[];
  onDisabledRows: TOnDisabledRows;
  table?: unknown;
}

export function buildGateInterceptor(opts: GateInterceptorOpts): TInterceptorDef {
  const { action, level, disabled, onDisabledRows, table } = opts;
  return defineBeforeInterceptor(async () => {
    injectBoundTable(table);
    const ctx = current();
    if (level === "row") {
      const row = await ctx.get(dbActionRowSlot);
      const verdicts = disabled([row]);
      assertVerdictLength(action, verdicts, 1);
      if (verdicts[0]) {
        const id = await ctx.get(dbActionIdSlot);
        throw new ActionDisabledError(action, id);
      }
      return;
    }

    const ids = (await ctx.get(dbActionIdsSlot)) as Record<string, unknown>[];
    const rows = (await ctx.get(dbActionRowsSlot)) as Array<Record<string, unknown> | undefined>;
    const existingRows: unknown[] = [];
    for (const row of rows) {
      if (row !== undefined) {
        existingRows.push(row);
      }
    }

    const verdicts = disabled(existingRows);
    assertVerdictLength(action, verdicts, existingRows.length);

    const failingIds: Record<string, unknown>[] = [];
    const passingRows: unknown[] = [];
    const passingIds: Record<string, unknown>[] = [];
    let verdictIndex = 0;
    for (let i = 0; i < ids.length; i++) {
      const row = rows[i];
      const failed = row === undefined || verdicts[verdictIndex++];
      if (failed) {
        failingIds.push(ids[i]);
      } else {
        passingRows.push(row);
        passingIds.push(ids[i]);
      }
    }

    if (onDisabledRows === "skip") {
      if (passingRows.length === 0) {
        throw new ActionDisabledError(action, undefined, [...ids]);
      }
      if (failingIds.length > 0) {
        ctx.set(dbActionRowsSlot, Promise.resolve(passingRows));
        ctx.set(dbActionIdsSlot, Promise.resolve(passingIds));
      }
      return;
    }
    if (failingIds.length > 0) {
      throw new ActionDisabledError(action, undefined, failingIds);
    }
  }, GATE_PRIORITY);
}

function assertVerdictLength(
  action: string,
  verdicts: unknown,
  expected: number,
): asserts verdicts is boolean[] {
  if (!Array.isArray(verdicts) || verdicts.length !== expected) {
    throw new HttpError(
      500,
      `Action "${action}" disabled predicate returned an invalid verdict array`,
    );
  }
}

/** Thin interceptor for `@DbActionRow*` without `disabled` — injects only the bound table. */
export function buildThinInterceptor(opts: { table?: unknown }): TInterceptorDef {
  const { table } = opts;
  return defineBeforeInterceptor(() => {
    injectBoundTable(table);
  }, GATE_PRIORITY);
}
