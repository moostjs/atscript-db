import { cached, defineWook, key, type EventContext } from "@wooksjs/event-core";
import { useBody } from "@wooksjs/http-body";
import { HttpError } from "@moostjs/event-http";
import { getMoostMate, useControllerContext } from "moost";

import { MOOST_DB_ACTION, WARN_PREFIX, type TDbActionMeta } from "./keys";
import {
  isPkValidationSource,
  validateMultiPk,
  validateSinglePk,
  type PkValidationSource,
} from "./pk-validation";

// Resolution precedence: gate-injected slot → controller.readable → controller.table.
export const boundTableKey = key<unknown>("atscript_db_action_bound_table");

export function getActionTable(ctx: EventContext): unknown {
  if (ctx.has(boundTableKey)) {
    const fromSlot = ctx.get(boundTableKey);
    if (fromSlot) return fromSlot;
  }
  const ctrl = useControllerContext(ctx).getController() as
    | { readable?: unknown; table?: unknown }
    | undefined;
  if (ctrl) {
    const t = ctrl.readable ?? ctrl.table;
    if (t) return t;
  }
  return null;
}

function noTableError(ctx: EventContext): HttpError {
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

async function resolveValidatedPk(
  ctx: EventContext,
  validate: (body: unknown, src: PkValidationSource) => void,
): Promise<unknown> {
  const table = getActionTable(ctx);
  if (!isPkValidationSource(table)) {
    throw noTableError(ctx);
  }
  const body = await useBody(ctx).parseBody<unknown>();
  validate(body, table);
  return body;
}

export const dbActionPkSlot = cached<Promise<unknown>>((ctx) =>
  resolveValidatedPk(ctx, validateSinglePk),
);

// Gate's skip mode overwrites this slot via ctx.set with the survivors.
export const dbActionPksSlot = cached<Promise<unknown[]>>(async (ctx) => {
  const result = await resolveValidatedPk(ctx, validateMultiPk);
  return result as unknown[];
});

export const useDbActionPk = defineWook((ctx) => ({
  load: () => ctx.get(dbActionPkSlot),
}));

export const useDbActionPks = defineWook((ctx) => ({
  load: () => ctx.get(dbActionPksSlot),
}));
