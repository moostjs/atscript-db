import { current, type EventContext } from "@wooksjs/event-core";
import { defineBeforeInterceptor, type TInterceptorDef } from "moost";

import { ActionDisabledError } from "./action-disabled-error";
import { boundTableKey, controllerTable, dbActionIdSlot, dbActionIdsSlot } from "./id-cache";
import { dbActionRowSlot, dbActionRowsSlot } from "./row-cache";
import { ACTION_GATE_PRIORITY, awaitActionPrepared } from "./prepare-request";
import { dbActionOverlaySlot } from "./row-scope";
import type { TDbActionDisabledVerdict, TOnDisabledRows } from "./types";
import { judgeRow, judgeRows, verdictReason } from "./verdict";

// Bound-table controller wins over opts.table (spec contract).
function injectBoundTable(fallback: unknown): void {
  const ctx = current();
  if (ctx.has(boundTableKey)) return;
  const t = controllerTable(ctx) ?? fallback;
  if (t != null) ctx.set(boundTableKey, t);
}

export interface GateInterceptorOpts {
  action: string;
  level: "row" | "rows";
  disabled: (rows: unknown[]) => TDbActionDisabledVerdict[];
  onDisabledRows: TOnDisabledRows;
  table?: unknown;
}

export function buildGateInterceptor(opts: GateInterceptorOpts): TInterceptorDef {
  const { action, level, disabled, onDisabledRows, table } = opts;
  return defineBeforeInterceptor(async () => {
    const ctx = current();
    // The controller's `prepareRequest` first (since 0.1.143) — before any
    // id is validated or row loaded — then its row overlay, before the body
    // is read: authorize before parsing input (moost ≤ 0.6.39 also dropped
    // the event's DI scope once the request stream ended).
    await awaitActionPrepared(ctx);
    injectBoundTable(table);
    await ctx.get(dbActionOverlaySlot);
    if (level === "row") {
      const row = await ctx.get(dbActionRowSlot);
      const verdict = judgeRow(action, disabled, row);
      if (verdict) {
        const id = await ctx.get(dbActionIdSlot);
        throw new ActionDisabledError(action, id, undefined, [verdictReason(verdict)]);
      }
      return;
    }
    await gateRows(ctx, action, disabled, onDisabledRows);
  }, ACTION_GATE_PRIORITY);
}

/**
 * `'rows'` level: a request id without a loaded row (missing, or outside the
 * row overlay — indistinguishable) fails like a disabled row with no reason;
 * `disabled` (when given) judges the loaded rows. Then `onDisabledRows`
 * applies: `'reject'` → 409 listing every failing id; `'skip'` → the cached
 * ids / rows narrow to the survivors (zero survivors → 409 with every id).
 */
async function gateRows(
  ctx: EventContext,
  action: string,
  disabled: ((rows: unknown[]) => TDbActionDisabledVerdict[]) | undefined,
  onDisabledRows: TOnDisabledRows,
): Promise<void> {
  const ids = (await ctx.get(dbActionIdsSlot)) as Record<string, unknown>[];
  const rows = (await ctx.get(dbActionRowsSlot)) as Array<Record<string, unknown> | undefined>;
  const existingRows: unknown[] = [];
  for (const row of rows) {
    if (row !== undefined) {
      existingRows.push(row);
    }
  }

  const verdicts = disabled ? judgeRows(action, disabled, existingRows) : undefined;

  const failingIds: Record<string, unknown>[] = [];
  const failingReasons: (string | undefined)[] = [];
  const passingRows: unknown[] = [];
  const passingIds: Record<string, unknown>[] = [];
  let verdictIndex = 0;
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i];
    const verdict = row === undefined ? undefined : verdicts?.[verdictIndex++];
    if (row === undefined || verdict) {
      failingIds.push(ids[i]);
      failingReasons.push(verdictReason(verdict));
    } else {
      passingRows.push(row);
      passingIds.push(ids[i]);
    }
  }

  if (onDisabledRows === "skip") {
    if (passingRows.length === 0) {
      // Zero survivors: every request id failed, so failingReasons aligns with `ids`.
      throw new ActionDisabledError(action, undefined, [...ids], failingReasons);
    }
    if (failingIds.length > 0) {
      ctx.set(dbActionRowsSlot, Promise.resolve(passingRows));
      ctx.set(dbActionIdsSlot, Promise.resolve(passingIds));
    }
    return;
  }
  if (failingIds.length > 0) {
    throw new ActionDisabledError(action, undefined, failingIds, failingReasons);
  }
}

export interface ThinInterceptorOpts {
  table?: unknown;
  /**
   * Row-overlay verification (since 0.1.143) — set for every `'row'` /
   * `'rows'` action without `disabled`. Omitted: bound-table injection only.
   */
  scope?: {
    action: string;
    level: "row" | "rows";
    onDisabledRows: TOnDisabledRows;
  };
}

/**
 * Interceptor for `'row'` / `'rows'` actions without `disabled` (and for a
 * `@DbActionRow*` handler of any other level: bound-table injection only):
 * runs the controller's `prepareRequest` (when defined, since 0.1.143),
 * injects the bound table and — only when the controller has a row overlay
 * for the action (`transformOne` / `transformFilter` overridden, or — since
 * 0.1.145 — an `actionRowScope` for it; non-empty) — verifies the
 * requested ids against it before the handler runs by loading the row(s)
 * the handler would get: `'row'` → the 404 of a missing row; `'rows'` →
 * out-of-scope and missing ids fail like disabled rows with no reason
 * (`onDisabledRows`). No overlay → no query.
 */
export function buildThinInterceptor(opts: ThinInterceptorOpts): TInterceptorDef {
  const { table, scope } = opts;
  return defineBeforeInterceptor(async () => {
    const ctx = current();
    await awaitActionPrepared(ctx);
    injectBoundTable(table);
    if (!scope) return;
    if (!(await ctx.get(dbActionOverlaySlot))) return;
    if (scope.level === "rows") {
      await gateRows(ctx, scope.action, undefined, scope.onDisabledRows);
    } else {
      await ctx.get(dbActionRowSlot);
    }
  }, ACTION_GATE_PRIORITY);
}
