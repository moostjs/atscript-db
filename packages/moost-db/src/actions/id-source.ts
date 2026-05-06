import { ApplyDecorators, Resolve } from "moost";
import { current } from "@wooksjs/event-core";

import { getAtscriptDbMate } from "../mate";
import { dbActionIdSlot, dbActionIdsSlot } from "./id-cache";
import type { TDbActionParamKind } from "./keys";

/**
 * Build a parameter decorator that reads its value from the cached ID wook
 * (single or multi). Validation runs inside the wook factory exactly once
 * per request, regardless of how many readers consume the value (`@DbActionID*`
 * resolver, gate interceptor, cached row wook, in-handler composables).
 *
 * Marks the param so {@link discoverActions} can infer the action's `level`.
 */
export function createIdParamDecorator(kind: TDbActionParamKind): ParameterDecorator {
  const resolverName = kind === "id" ? "dbActionId" : "dbActionIds";
  const resolver =
    kind === "id"
      ? async () => current().get(dbActionIdSlot)
      : async () => current().get(dbActionIdsSlot);
  return ApplyDecorators(
    getAtscriptDbMate().decorate("atscript_db_action_param", kind),
    Resolve(resolver, resolverName),
  );
}
