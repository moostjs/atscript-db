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
