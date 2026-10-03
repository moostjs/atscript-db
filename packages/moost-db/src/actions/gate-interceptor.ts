import { current, type EventContext } from "@wooksjs/event-core";
import { defineBeforeInterceptor, defineInterceptor, type TInterceptorDef } from "moost";

import { ActionDisabledError } from "./action-disabled-error";
import { boundTableKey, controllerTable, dbActionIdSlot, dbActionIdsSlot } from "./id-cache";
import { dbActionRowSlot, dbActionRowsSlot } from "./row-cache";
import { ACTION_GATE_PRIORITY, awaitActionPrepared } from "./prepare-request";
import {
  dbActionQueryTargetSlot,
  dbActionSkippedKey,
  dbActionStaleKey,
  type TSkippedRow,
} from "./query-target";
import { dbActionOverlaySlot, isActionScoped } from "./row-scope";
import {
  abortStreamedTarget,
  dbActionTargetKey,
  setMaterializedTarget,
  setStreamedTarget,
} from "./target";
import type { TDbActionDisabledVerdict, TOnDisabledRows } from "./types";
import { judgeRow, judgeRows, verdictReason } from "./verdict";

// Bound-table controller wins over opts.table (spec contract).
function injectBoundTable(fallback: unknown): void {
  const ctx = current();
  if (ctx.has(boundTableKey)) return;
  const t = controllerTable(ctx) ?? fallback;
  if (t != null) ctx.set(boundTableKey, t);
}

/**
 * A query target the handler never runs for: a dry run → `{ matched }`; a
 * query matching no row → its (empty) summary (since 0.1.147).
 */
async function queryTargetReply(ctx: EventContext, reply: (r: unknown) => void): Promise<boolean> {
  const target = await ctx.get(dbActionQueryTargetSlot);
  if (!target) return false;
  if (target.dryRun) {
    reply({ matched: target.matched });
    return true;
  }
  if (target.ids.length > 0) return false;
  await setMaterializedTarget(ctx);
  reply(ctx.get(dbActionTargetKey).summary());
  return true;
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
  return defineBeforeInterceptor(async (reply) => {
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
    if (await queryTargetReply(ctx, reply)) return;
    await gateRows(ctx, action, disabled, onDisabledRows);
    await setMaterializedTarget(ctx);
  }, ACTION_GATE_PRIORITY);
}

/**
 * `'rows'` level: a request id without a loaded row (missing, outside the
 * row overlay or the action's `actionRowScope` — indistinguishable; for a
 * query target also a row that no longer matches the query) fails like a
 * disabled row with no reason; `disabled` (when given) judges the loaded
 * rows. Then `onDisabledRows` applies: `'reject'` → 409 listing every
 * failing id; `'skip'` → the cached ids / rows narrow to the survivors (zero
 * survivors → 409 with every id) and the skipped ids are recorded for
 * `useDbActionTarget().summary()` (since 0.1.147).
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
  const skipped: TSkippedRow[] = [];
  const stale = ctx.has(dbActionStaleKey) ? ctx.get(dbActionStaleKey) : undefined;
  let verdictIndex = 0;
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i];
    const verdict = row === undefined ? undefined : verdicts?.[verdictIndex++];
    if (row === undefined || verdict) {
      const reason = verdictReason(verdict);
      failingIds.push(ids[i]);
      failingReasons.push(reason);
      const skipReason = reason ?? (stale?.has(i) ? "stale" : undefined);
      skipped.push(skipReason === undefined ? { id: ids[i] } : { id: ids[i], reason: skipReason });
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
      ctx.set(dbActionRowsSlot, Promise.resolve(passingRows) as never);
      ctx.set(dbActionIdsSlot, Promise.resolve(passingIds));
      ctx.set(dbActionSkippedKey, skipped);
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
 * (`transformOne` / `transformFilter` overridden, non-empty), overrides
 * `actionRowScope` (since 0.1.145) or the request is a query target (since
 * 0.1.147) — verifies the requested ids before the handler runs by loading
 * the row(s) the handler would get: `'row'` → the 404 of a missing row;
 * `'rows'` → out-of-scope and missing ids fail like disabled rows with no
 * reason (`onDisabledRows`). Nothing to verify → no query.
 */
export function buildThinInterceptor(opts: ThinInterceptorOpts): TInterceptorDef {
  const { table, scope } = opts;
  return defineBeforeInterceptor(async (reply) => {
    const ctx = current();
    await awaitActionPrepared(ctx);
    injectBoundTable(table);
    if (!scope) return;
    const overlay = await ctx.get(dbActionOverlaySlot);
    if (scope.level === "row") {
      if (overlay || isActionScoped(ctx)) await ctx.get(dbActionRowSlot);
      return;
    }
    if (await queryTargetReply(ctx, reply)) return;
    const target = await ctx.get(dbActionQueryTargetSlot);
    if (overlay || target || isActionScoped(ctx)) {
      await gateRows(ctx, scope.action, undefined, scope.onDisabledRows);
    }
    await setMaterializedTarget(ctx);
  }, ACTION_GATE_PRIORITY);
}

export interface TargetInterceptorOpts {
  action: string;
  disabled?: (rows: unknown[]) => TDbActionDisabledVerdict[];
  table?: unknown;
}

/**
 * Interceptor of a `@DbActionTarget()` handler (since 0.1.147): runs
 * `prepareRequest`, the row overlay, then resolves the target — `{ ids }`
 * validated, `{ query }` resolved (phase 1; a dry run replies `{ matched }`
 * and a query matching no row its empty summary here, without the handler).
 * Its rows are gated batch by batch while the handler iterates them. A
 * handler failing after it received a batch answers the partial summary
 * with `aborted` (the batch it was on and every row not reached in
 * `failed`) instead of the bare error.
 */
export function buildTargetInterceptor(opts: TargetInterceptorOpts): TInterceptorDef {
  const { action, disabled, table } = opts;
  return defineInterceptor(
    {
      async before(reply) {
        const ctx = current();
        await awaitActionPrepared(ctx);
        injectBoundTable(table);
        const { target, dryRun } = await setStreamedTarget(ctx, action, disabled);
        if (dryRun) reply({ matched: target.matched });
        else if (target.kind === "query" && target.matched === 0) reply(target.summary());
      },
      error(error, reply) {
        const summary = abortStreamedTarget(current(), error);
        if (summary) reply(summary);
      },
    },
    ACTION_GATE_PRIORITY,
  );
}
