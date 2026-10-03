import { cached, defineWook, type EventContext } from "@wooksjs/event-core";

import { boundTableKey, controllerOf, noTableError } from "./controller-access";
import { actionMaxIds } from "./current-action";
import { dbActionBodySlot } from "./input-form-cache";
import { awaitActionPrepared } from "./prepare-request";
import { dbActionQueryTargetSlot } from "./query-target";
import {
  isIdValidationSource,
  validateMultiId,
  validateSingleId,
  type IdValidationSource,
} from "./id-validation";

export {
  boundTableKey,
  controllerOf,
  controllerTable,
  getActionTable,
  noTableError,
} from "./controller-access";
export { DEFAULT_MAX_ACTION_IDS } from "./current-action";

/**
 * Validates the body's `ids` against the action table's identifications. For
 * the controller's own table that is its `idSource` (since 0.1.134): a unique
 * index over a field `hasField` hides neither addresses a row nor appears in
 * the "must exactly match one of" message. An `opts.table` binding has no
 * visibility hook. The controller's `prepareRequest` (since 0.1.143) runs
 * first, so the visibility the ids are validated against is the request's.
 */
async function resolveValidatedId(
  ctx: EventContext,
  validate: (body: unknown, src: IdValidationSource) => unknown,
): Promise<unknown> {
  await awaitActionPrepared(ctx);
  const fromSlot = ctx.has(boundTableKey) ? ctx.get(boundTableKey) : undefined;
  let source = fromSlot;
  if (!source) {
    const ctrl = controllerOf(ctx);
    source = ctrl?.idSource ?? ctrl?.readable ?? ctrl?.table ?? null;
  }
  if (!isIdValidationSource(source)) {
    throw noTableError(ctx);
  }
  const env = await ctx.get(dbActionBodySlot);
  validate(env.ids, source);
  return env.ids;
}

export const dbActionIdSlot = cached<Promise<Record<string, unknown>>>(
  (ctx) => resolveValidatedId(ctx, validateSingleId) as Promise<Record<string, unknown>>,
);

/**
 * The `'rows'` action's identifiers: the body's validated `ids`, or — for a
 * query target (`query`, since 0.1.147) — the identities of the rows it
 * matched (phase 1).
 */
export const dbActionIdsSlot = cached<Promise<Record<string, unknown>[]>>(async (ctx) => {
  await awaitActionPrepared(ctx);
  const target = await ctx.get(dbActionQueryTargetSlot);
  if (target) return target.ids;
  const result = await resolveValidatedId(ctx, (body, src) =>
    validateMultiId(body, src, actionMaxIds(ctx)),
  );
  return result as Record<string, unknown>[];
});

export const useDbActionId = defineWook((ctx) => ({
  load: () => ctx.get(dbActionIdSlot),
}));

export const useDbActionIds = defineWook((ctx) => ({
  load: () => ctx.get(dbActionIdsSlot),
}));
