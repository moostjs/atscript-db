import { isEmptyObject, type FilterExpr } from "@atscript/db";
import { cached, type EventContext } from "@wooksjs/event-core";

import { readCurrentActionMeta } from "./current-action";
import { controllerOf, controllerTable, getActionTable } from "./id-cache";
import { awaitActionPrepared } from "./prepare-request";

/**
 * The key of `AsDbReadableController`'s internal action-overlay method —
 * `rowOverlay()` AND (since 0.1.145) the action's `actionRowScope`. A
 * registered symbol: not an overridable seam, and still found when
 * moost-db loads in two module realms (moost-vite SSR).
 */
export const ACTION_OVERLAY = Symbol.for("atscript-db.actionOverlay");

/**
 * What the actions module applies to action ids / rows (since 0.1.143): the
 * controller's {@link ACTION_OVERLAY} method and `fieldVisibility`, reached
 * duck-typed like the rest of the controller surface (see
 * `id-cache.controllerTable`).
 */
interface TScopedController {
  [ACTION_OVERLAY]?: (action: string | undefined) => Promise<FilterExpr | undefined>;
  fieldVisibility?: { readonly scoped: boolean; readonly isVisible: (path: string) => boolean };
}

/**
 * The controller whose hooks govern this action's rows: only when the action
 * runs against the controller's OWN readable — an `opts.table` binding on a
 * plain controller has no row overlay or visibility hook. Once per event.
 */
const scopedControllerSlot = cached<TScopedController | null>((ctx) => {
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
 * `rowOverlay()` (the overlay `/one/:id` ANDs in) AND, since 0.1.145, the
 * action's `actionRowScope`; `null` when both are empty (no hook call, no
 * extra query when the controller overrides none of `transformOne`,
 * `transformFilter`, `actionRowScope`). Evaluated once per request, after
 * the controller's `prepareRequest` (since 0.1.143).
 */
export const dbActionOverlaySlot = cached<Promise<FilterExpr | null>>(async (ctx) => {
  const ctrl = ctx.get(scopedControllerSlot);
  const overlayOf = ctrl?.[ACTION_OVERLAY];
  if (!overlayOf) return null;
  await awaitActionPrepared(ctx);
  return (await overlayOf.call(ctrl, readCurrentActionMeta(ctx)?.name)) ?? null;
});

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
