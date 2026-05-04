import { cached, defineWook, key, type EventContext } from "@wooksjs/event-core";
import { HttpError } from "@moostjs/event-http";
import { useControllerContext } from "moost";

import { readCurrentActionMeta } from "./current-action";
import { dbActionBodySlot } from "./input-form-cache";
import { WARN_PREFIX } from "./keys";
import {
  isIdValidationSource,
  validateMultiId,
  validateSingleId,
  type IdValidationSource,
} from "./id-validation";

export const boundTableKey = key<unknown>("atscript_db_action_bound_table");

export function controllerTable(ctx: EventContext): unknown {
  const ctrl = useControllerContext(ctx).getController() as
    | { readable?: unknown; table?: unknown }
    | null
    | undefined;
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

async function resolveValidatedId(
  ctx: EventContext,
  validate: (body: unknown, src: IdValidationSource) => unknown,
): Promise<unknown> {
  const table = getActionTable(ctx);
  if (!isIdValidationSource(table)) {
    throw noTableError(ctx);
  }
  const env = await ctx.get(dbActionBodySlot);
  validate(env.ids, table);
  return env.ids;
}

export const dbActionIdSlot = cached<Promise<Record<string, unknown>>>(
  (ctx) => resolveValidatedId(ctx, validateSingleId) as Promise<Record<string, unknown>>,
);

export const dbActionIdsSlot = cached<Promise<Record<string, unknown>[]>>(async (ctx) => {
  const result = await resolveValidatedId(ctx, validateMultiId);
  return result as Record<string, unknown>[];
});

export const useDbActionId = defineWook((ctx) => ({
  load: () => ctx.get(dbActionIdSlot),
}));

export const useDbActionIds = defineWook((ctx) => ({
  load: () => ctx.get(dbActionIdsSlot),
}));
