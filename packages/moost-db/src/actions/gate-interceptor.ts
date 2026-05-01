import { current } from "@wooksjs/event-core";
import {
  defineBeforeInterceptor,
  TInterceptorPriority,
  useControllerContext,
  type TInterceptorDef,
} from "moost";

import { ActionDisabledError } from "./action-disabled-error";
import { isAsDbReadableControllerInstance } from "./controller-registry";
import { boundTableKey, dbActionPkSlot, dbActionPksSlot } from "./pk-cache";
import { dbActionRowSlot, dbActionRowsSlot } from "./row-cache";
import type { TOnDisabledRows } from "./types";

// AFTER_GUARD: pins the gate after `@Authenticate` and before the resolve pipe.
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
  disabled: (row: unknown) => boolean;
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
      if (disabled(row)) {
        const pk = await ctx.get(dbActionPkSlot);
        throw new ActionDisabledError(action, pk);
      }
      return;
    }
    const pks = (await ctx.get(dbActionPksSlot)) as unknown[];
    const rows = (await ctx.get(dbActionRowsSlot)) as unknown[];
    const failingPks: unknown[] = [];
    const passingRows: unknown[] = [];
    const passingPks: unknown[] = [];
    // FULL scan — must not short-circuit; reject mode lists ALL failing PKs.
    for (let i = 0; i < rows.length; i++) {
      if (disabled(rows[i])) {
        failingPks.push(pks[i]);
      } else {
        passingRows.push(rows[i]);
        passingPks.push(pks[i]);
      }
    }
    if (onDisabledRows === "skip") {
      if (passingRows.length === 0) {
        throw new ActionDisabledError(action, undefined, [...pks]);
      }
      if (failingPks.length > 0) {
        ctx.set(dbActionRowsSlot, Promise.resolve(passingRows));
        ctx.set(dbActionPksSlot, Promise.resolve(passingPks));
      }
      return;
    }
    if (failingPks.length > 0) {
      throw new ActionDisabledError(action, undefined, failingPks);
    }
  }, GATE_PRIORITY);
}

/** Thin interceptor for `@DbActionRow*` without `disabled` — injects only the bound table. */
export function buildThinInterceptor(opts: { table?: unknown }): TInterceptorDef {
  const { table } = opts;
  return defineBeforeInterceptor(() => {
    injectBoundTable(table);
  }, GATE_PRIORITY);
}
