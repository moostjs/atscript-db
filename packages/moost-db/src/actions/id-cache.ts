import { cached, defineWook, key, type EventContext } from "@wooksjs/event-core";
import { useBody } from "@wooksjs/http-body";
import { HttpError } from "@moostjs/event-http";
import { getMoostMate, useControllerContext } from "moost";

import { MOOST_DB_ACTION, WARN_PREFIX, type TDbActionMeta } from "./keys";
import {
  isIdValidationSource,
  validateMultiId,
  validateSingleId,
  type IdValidationSource,
} from "./id-validation";

export const boundTableKey = key<unknown>("atscript_db_action_bound_table");

export function getActionTable(ctx: EventContext): unknown {
  const fromSlot = ctx.has(boundTableKey) ? ctx.get(boundTableKey) : undefined;
  if (fromSlot) return fromSlot;
  const ctrl = useControllerContext(ctx).getController() as
    | { readable?: unknown; table?: unknown }
    | undefined;
  return ctrl?.readable ?? ctrl?.table ?? null;
}

export function noTableError(ctx: EventContext): HttpError {
  const cc = useControllerContext(ctx);
  const ctrl = cc.getController() as object | undefined;
  const methodName = cc.getMethod();
  let actionName: string | undefined;
  if (ctrl && methodName) {
    const meta = getMoostMate().read(ctrl.constructor, methodName) as
      | { [MOOST_DB_ACTION]?: TDbActionMeta }
      | undefined;
    actionName = meta?.[MOOST_DB_ACTION]?.name;
  }
  const tag = actionName ? `"${actionName}"` : "<unknown>";
  return new HttpError(
    500,
    `${WARN_PREFIX} ${tag}: controller has no readable/table property and the action declares no opts.table. Either expose readable/table on the controller, extend AsDbReadableController, or pass opts.table on @DbAction.`,
  );
}

async function resolveValidatedId(
  ctx: EventContext,
  validate: (body: unknown, src: IdValidationSource) => unknown,
): Promise<unknown> {
  const table = getActionTable(ctx);
  if (!isIdValidationSource(table)) {
    throw noTableError(ctx);
  }
  const body = await useBody(ctx).parseBody<unknown>();
  validate(body, table);
  return body;
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
