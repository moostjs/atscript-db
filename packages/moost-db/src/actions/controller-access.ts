import { key, type EventContext } from "@wooksjs/event-core";
import { HttpError } from "@moostjs/event-http";
import { useControllerContext } from "moost";

import { readCurrentActionMeta } from "./current-action";
import type { IdValidationSource } from "./id-validation";
import { WARN_PREFIX } from "./keys";

export const boundTableKey = key<unknown>("atscript_db_action_bound_table");

/** What the actions module reads off a controller (duck-typed — see `controller-registry`). */
export interface TActionController {
  readable?: unknown;
  table?: unknown;
  /** `AsDbReadableController.idSource`: identifications narrowed by `hasField` (since 0.1.134). */
  idSource?: IdValidationSource;
}

export function controllerOf(ctx: EventContext): TActionController | null | undefined {
  return useControllerContext(ctx).getController() as TActionController | null | undefined;
}

export function controllerTable(ctx: EventContext): unknown {
  const ctrl = controllerOf(ctx);
  return ctrl?.readable ?? ctrl?.table ?? null;
}

export function getActionTable(ctx: EventContext): unknown {
  const fromSlot = ctx.has(boundTableKey) ? ctx.get(boundTableKey) : undefined;
  return fromSlot ?? controllerTable(ctx);
}

const warnedTags = new Set<string>();

export function noTableError(ctx: EventContext): HttpError {
  const actionName = readCurrentActionMeta(ctx)?.name;
  const tag = actionName ? `"${actionName}"` : "<unknown>";
  // Log details server-side once per action; client gets a generic 500.
  if (!warnedTags.has(tag)) {
    warnedTags.add(tag);
    // eslint-disable-next-line no-console
    console.warn(
      `${WARN_PREFIX} ${tag}: controller has no readable/table property and the action declares no opts.table. ` +
        `Either expose readable/table on the controller, extend AsDbReadableController, or pass opts.table on @DbAction.`,
    );
  }
  return new HttpError(500, {
    statusCode: 500,
    error: "Internal Server Error",
    message: "Internal server error",
    code: "ACTION_TABLE_NOT_BOUND",
  });
}
