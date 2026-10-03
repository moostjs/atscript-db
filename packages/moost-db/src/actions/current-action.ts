import { type EventContext } from "@wooksjs/event-core";
import { useControllerContext } from "moost";

import { getAtscriptDbMate } from "../mate";
import type { TDbActionMeta } from "./keys";

/** Read the current action's `TDbActionMeta` from the wook context. Returns undefined outside a controller (e.g. direct-wook test paths). */
export function readCurrentActionMeta(ctx: EventContext): TDbActionMeta | undefined {
  let ctrl: object | undefined;
  let methodName: string | undefined;
  try {
    const cc = useControllerContext(ctx);
    ctrl = cc.getController() as object | undefined;
    methodName = cc.getMethod();
  } catch {
    return undefined;
  }
  if (!ctrl || !methodName) return undefined;
  const meta = getAtscriptDbMate().read(ctrl.constructor, methodName);
  return meta?.atscript_db_action;
}

/** Default cap on the identifiers one `'rows'`-level request may carry — see `DbActionOpts.maxIds`. */
export const DEFAULT_MAX_ACTION_IDS = 1000;

/** `opts.maxIds` of `opts` (`@DbAction` options), else {@link DEFAULT_MAX_ACTION_IDS}. */
export function maxIdsOfOpts(opts: unknown): number {
  const max = (opts as { maxIds?: unknown } | undefined)?.maxIds;
  return typeof max === "number" && Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_ACTION_IDS;
}

/** The current action's `maxIds` (see {@link maxIdsOfOpts}). */
export function actionMaxIds(ctx: EventContext): number {
  return maxIdsOfOpts(readCurrentActionMeta(ctx)?.opts);
}
