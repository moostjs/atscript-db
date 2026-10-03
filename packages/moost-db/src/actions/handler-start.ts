import { current, key, type EventContext } from "@wooksjs/event-core";
import { TPipePriority, definePipeFn, type TPipeFn } from "moost";

import type { AtscriptDbMeta } from "../mate";

/**
 * Set in an action event once every argument of its handler resolved — the
 * handler method runs next. Before it: guards, the action gate (which builds
 * the target), any later interceptor, `@InputForm` validation and every
 * other param pipe — a failure there means the handler never ran.
 */
export const dbActionHandlerStartedKey = key<true>("atscript_db_action_handler_started");

/** Indexes of the action handler's arguments resolved so far (this event's own). */
export const dbActionArgsResolvedKey = key<Set<number>>("atscript_db_action_args_resolved");

/** After every moost pipe priority — the last step of resolving an argument. */
const HANDLER_START_PRIORITY = (TPipePriority.AFTER_VALIDATE + 1) as TPipePriority;

/**
 * Method pipe of every `@DbAction` handler: records each argument as it
 * finishes resolving; with the last one the handler starts. Interceptor
 * methods resolving their own arguments through the same pipes are ignored
 * (their method meta carries no action).
 */
export const markHandlerStartPipe: TPipeFn<AtscriptDbMeta> = definePipeFn<AtscriptDbMeta>(
  (value, metas, level) => {
    const total = metas.methodMeta?.params?.length ?? 0;
    if (level !== "PARAM" || !metas.methodMeta?.atscript_db_action || metas.index === undefined) {
      return value;
    }
    const ctx = current();
    let seen = ctx.hasOwn(dbActionArgsResolvedKey)
      ? ctx.getOwn(dbActionArgsResolvedKey)
      : undefined;
    if (!seen) {
      seen = new Set();
      ctx.set(dbActionArgsResolvedKey, seen);
    }
    seen.add(metas.index);
    if (seen.size >= total) ctx.set(dbActionHandlerStartedKey, true);
    return value;
  },
  HANDLER_START_PRIORITY,
);

/**
 * `true` once the current action event's handler started (every `'rows'`
 * action has an argument, so its start is always observed).
 */
export function actionHandlerStarted(ctx: EventContext = current()): boolean {
  return ctx.hasOwn(dbActionHandlerStartedKey);
}
