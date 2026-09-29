import type { FilterExpr } from "@atscript/db";
import { cached, type EventContext } from "@wooksjs/event-core";

import { controllerOf, controllerTable, getActionTable } from "./id-cache";
import { awaitActionPrepared } from "./prepare-request";

/**
 * What the actions module applies to action ids / rows (since 0.1.143):
 * `AsDbReadableController`'s `rowOverlay()` and `fieldVisibility`, reached
 * duck-typed like the rest of the controller surface (see
 * `id-cache.controllerTable`).
 */
interface TScopedController {
  rowOverlay?: () => Promise<FilterExpr | undefined>;
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
 * The controller's row overlay for action ids / rows — its `rowOverlay()`,
 * the same overlay `/one/:id` ANDs in (no hook call, no extra query when the
 * controller overrides neither `transformOne` nor `transformFilter`), `null`
 * when there is none. Evaluated once per request, after the controller's
 * `prepareRequest` (since 0.1.143).
 */
export const dbActionOverlaySlot = cached<Promise<FilterExpr | null>>(async (ctx) => {
  const ctrl = ctx.get(scopedControllerSlot);
  if (!ctrl?.rowOverlay) return null;
  await awaitActionPrepared(ctx);
  return (await ctrl.rowOverlay()) ?? null;
});

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
