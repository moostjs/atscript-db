import { cached, current, type EventContext } from "@wooksjs/event-core";
import {
  defineBeforeInterceptor,
  TInterceptorPriority,
  useControllerContext,
  type TInterceptorDef,
} from "moost";

import type { TDbRequestContext } from "../as-readable.controller";
import { readCurrentActionMeta } from "./current-action";

/** The action entry reads `prepareRequest` off the controller duck-typed (see `id-cache.controllerTable`). */
interface TPreparingController {
  prepareRequest?: (ctx: TDbRequestContext) => void | Promise<void>;
}

/**
 * The controller's `prepareRequest({ endpoint: "action", action })` for this
 * `@DbAction` event (since 0.1.143) — started once per event, before the
 * action's ids are validated, its rows loaded or its row overlay built (each
 * of those awaits it first). `undefined` when the controller defines no
 * `prepareRequest` (nothing to await) or outside an action handler.
 */
const dbActionPreparedSlot = cached<Promise<void> | undefined>((ctx) => {
  let ctrl: TPreparingController | null | undefined;
  try {
    ctrl = useControllerContext(ctx).getController() as TPreparingController | null | undefined;
  } catch {
    return undefined; // outside a controller (direct wook usage)
  }
  const prepare = ctrl?.prepareRequest;
  if (typeof prepare !== "function") return undefined;
  const action = readCurrentActionMeta(ctx)?.name;
  if (action === undefined) return undefined;
  // Async wrapper: a synchronous throw becomes the cached rejection.
  return (async () => prepare.call(ctrl, { endpoint: "action", action }))();
});

/** Awaits the controller's `prepareRequest` for this action event (no-op without one). */
export async function awaitActionPrepared(ctx: EventContext): Promise<void> {
  const pending = ctx.get(dbActionPreparedSlot);
  if (pending) await pending;
}

/** Same priority as the action gate: after the guards (auth) ran, before argument resolution. */
export const ACTION_GATE_PRIORITY = TInterceptorPriority.AFTER_GUARD;

/**
 * Interceptor for `'table'`-level actions of an `AsReadableController`
 * subclass (the gate / thin interceptor cover `'row'` / `'rows'`): runs the
 * controller's `prepareRequest` before the handler. No `prepareRequest` →
 * returns without awaiting.
 */
export const actionPrepareInterceptor: TInterceptorDef = defineBeforeInterceptor(
  () => current().get(dbActionPreparedSlot),
  ACTION_GATE_PRIORITY,
);
