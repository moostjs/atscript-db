import { ApplyDecorators, Resolve, getMoostMate } from "moost";
import { current } from "@wooksjs/event-core";

import { dbActionPkSlot, dbActionPksSlot } from "./pk-cache";
import { MOOST_DB_ACTION_PARAM, type TDbActionParamKind } from "./keys";

/**
 * Build a parameter decorator that reads its value from the cached PK wook
 * (single or multi). Validation runs inside the wook factory exactly once
 * per request, regardless of how many readers consume the value (`@DbActionPK*`
 * resolver, gate interceptor, cached row wook, in-handler composables).
 *
 * Marks the param so {@link discoverActions} can infer the action's `level`.
 */
export function createPkParamDecorator(kind: TDbActionParamKind): ParameterDecorator {
  const mate = getMoostMate();
  const slot = kind === "pk" ? dbActionPkSlot : dbActionPksSlot;
  const resolverName = kind === "pk" ? "dbActionPk" : "dbActionPks";
  return ApplyDecorators(
    mate.decorate(MOOST_DB_ACTION_PARAM, kind),
    Resolve(async () => current().get(slot), resolverName),
  );
}
