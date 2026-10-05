import { isEmptyObject, type FilterExpr } from "@atscript/db";
import { cached, type EventContext } from "@wooksjs/event-core";

import { readCurrentActionMeta } from "./current-action";
import { controllerOf, controllerTable, getActionTable } from "./controller-access";
import { awaitActionPrepared } from "./prepare-request";
import { findRowsByIds, type TAppliedIds, type TRowsByIdSource } from "./rows-by-id";
import type { TDbRowIdsContext } from "./types";
import { candidateIds, createScopeContext, type TDbActionScopeContext } from "./scope-context";

/**
 * The key of `AsDbReadableController`'s internal action-overlay method —
 * its `rowOverlay()` (since 0.1.147 without the action's `actionRowScope`,
 * which needs the candidate rows — see {@link ACTION_SCOPE}). A registered
 * symbol: not an overridable seam, and still found when moost-db loads in
 * two module realms (moost-vite SSR).
 */
export const ACTION_OVERLAY = Symbol.for("atscript-db.actionOverlay");

/** The controller's internal `actionRowScope` call for candidate rows (since 0.1.147). */
export const ACTION_SCOPE = Symbol.for("atscript-db.actionScope");

/** `true` when the controller overrides `actionRowScope` (since 0.1.147). */
export const ACTION_SCOPED = Symbol.for("atscript-db.actionScoped");

/** The controller's internal `resolveRowIds` call for an action's ids (since 0.1.148). */
export const ROW_RESOLVE_IDS = Symbol.for("atscript-db.resolveRowIds");

/** `true` when the controller overrides `resolveRowIds` (since 0.1.148). */
export const ROW_RESOLVES = Symbol.for("atscript-db.rowResolves");

/**
 * What the actions module applies to action ids / rows (since 0.1.143): the
 * controller's {@link ACTION_OVERLAY} / {@link ACTION_SCOPE} methods and
 * `fieldVisibility`, reached duck-typed like the rest of the controller
 * surface (see `id-cache.controllerTable`).
 */
interface TScopedController {
  [ACTION_OVERLAY]?: () => Promise<FilterExpr | undefined>;
  [ACTION_SCOPE]?: (action: string, ctx: TDbActionScopeContext) => Promise<FilterExpr | undefined>;
  readonly [ACTION_SCOPED]?: boolean;
  [ROW_RESOLVE_IDS]?: (
    ids: readonly Record<string, unknown>[],
    ctx: TDbRowIdsContext,
  ) => Promise<TAppliedIds>;
  readonly [ROW_RESOLVES]?: boolean;
  fieldVisibility?: { readonly scoped: boolean; readonly isVisible: (path: string) => boolean };
}

/** A table the scope check reads candidates from (`preferredId` / `primaryKeys` name them). */
export interface TScopeTable extends TRowsByIdSource {
  primaryKeys: readonly string[];
  preferredId?: readonly string[];
}

/**
 * The controller whose hooks govern this action's rows: only when the action
 * runs against the controller's OWN readable — an `opts.table` binding on a
 * plain controller has no row overlay or visibility hook. Once per event.
 */
export const scopedControllerSlot = cached<TScopedController | null>((ctx) => {
  let ctrl: TScopedController | null | undefined;
  try {
    ctrl = controllerOf(ctx) as TScopedController | null | undefined;
  } catch {
    return null; // outside a controller (direct wook usage) — nothing to scope by
  }
  const table = controllerTable(ctx);
  if (!ctrl || table == null || getActionTable(ctx) !== table) return null;
  return ctrl;
});

/**
 * The controller's row overlay for this action's ids / rows — its
 * `rowOverlay()`, the overlay `/one/:id` ANDs in; `null` when empty (no hook
 * call, no extra query when the controller overrides neither `transformOne`
 * nor `transformFilter`). Evaluated once per request, after the controller's
 * `prepareRequest` (since 0.1.143) and before the request body is read. The
 * action's `actionRowScope` is applied to the loaded rows afterwards (see
 * {@link applyActionScope}, since 0.1.147).
 */
export const dbActionOverlaySlot = cached<Promise<FilterExpr | null>>(async (ctx) => {
  const ctrl = ctx.get(scopedControllerSlot);
  const overlayOf = ctrl?.[ACTION_OVERLAY];
  if (!overlayOf) return null;
  await awaitActionPrepared(ctx);
  return (await overlayOf.call(ctrl)) ?? null;
});

/**
 * The loaded `rows` (already inside the row overlay) with every row outside
 * the action's `actionRowScope` replaced by `undefined` (since 0.1.147). The
 * hook sees the rows' identities (`purpose: "execute"`); a non-empty scope
 * costs ONE id-only query. No-op when the controller does not override the
 * hook.
 */
export async function applyActionScope(
  ctx: EventContext,
  table: TScopeTable,
  rows: Array<Record<string, unknown> | undefined>,
): Promise<Array<Record<string, unknown> | undefined>> {
  const ctrl = ctx.get(scopedControllerSlot);
  const action = readCurrentActionMeta(ctx)?.name;
  const scopeOf = ctrl?.[ACTION_SCOPED] ? ctrl[ACTION_SCOPE] : undefined;
  if (!scopeOf || action === undefined || rows.every((row) => row === undefined)) return rows;
  const idFields = table.preferredId?.length ? table.preferredId : table.primaryKeys;
  const { ids, index } = candidateIds(rows, idFields);
  // No candidate: no hook call — a row without its identity is in no scope.
  if (ids.length === 0) return rows.map(() => undefined);
  const scope = await scopeOf.call(ctrl, action, createScopeContext("execute", ids, table));
  if (!scope) return rows;
  const found = await findRowsByIds(table, ids, scope, []);
  return rows.map((row, i) => (row && index[i] >= 0 && found[index[i]] ? row : undefined));
}

/** `filter` unless it is absent or `{}`. */
export function nonEmptyFilter(filter: FilterExpr | null | undefined): FilterExpr | undefined {
  return filter && !isEmptyObject(filter) ? filter : undefined;
}

/** `filter` AND the overlay (identity without one). */
export function withOverlay(
  filter: FilterExpr,
  overlay: FilterExpr | null | undefined,
): FilterExpr {
  return overlay ? ({ $and: [filter, overlay] } as FilterExpr) : filter;
}

/**
 * The controller's field visibility when request-scoped (`hasField`
 * overridden), else `undefined` — `requiredFields` it hides (a derived field
 * over a hidden source included) are never selected.
 */
export function actionFieldVisibility(ctx: EventContext): ((path: string) => boolean) | undefined {
  const visibility = ctx.get(scopedControllerSlot)?.fieldVisibility;
  return visibility?.scoped ? visibility.isVisible : undefined;
}
