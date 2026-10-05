import { cached, defineWook, key, type EventContext } from "@wooksjs/event-core";

import { boundTableKey, controllerOf, noTableError } from "./controller-access";
import { actionMaxIds, readCurrentActionMeta } from "./current-action";
import { dbActionBodySlot } from "./input-form-cache";
import { awaitActionPrepared } from "./prepare-request";
import { dbActionQueryTargetSlot } from "./query-target";
import {
  dbActionOverlaySlot,
  ROW_RESOLVE_IDS,
  ROW_RESOLVES,
  scopedControllerSlot,
} from "./row-scope";
import { identityKey } from "./rows-by-id";
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
 * The ids as the client sent them, keyed by the {@link identityKey} of the id
 * they resolved to (since 0.1.148) — set only when the controller's
 * `resolveRowIds` changed an id. Every id moost-db reports back (gate
 * refusals, target summaries) is mapped through {@link requestIdOf}.
 */
export const dbActionRequestIdsKey = key<ReadonlyMap<string, Record<string, unknown>[]>>(
  "atscript_db_action_request_ids",
);

/** EVERY id the client sent that resolved to `id` — `[id]` when `resolveRowIds` did not change it. */
export function requestIdsFor(
  ctx: EventContext,
  id: Record<string, unknown>,
): Record<string, unknown>[] {
  if (!ctx.has(dbActionRequestIdsKey)) return [id];
  const k = identityKey(id);
  return (k === undefined ? undefined : ctx.get(dbActionRequestIdsKey).get(k)) ?? [id];
}

/** The id as the client sent it (the first, for an id several requests resolved to). */
export function requestIdOf(
  ctx: EventContext,
  id: Record<string, unknown>,
): Record<string, unknown> {
  return requestIdsFor(ctx, id)[0]!;
}

/** {@link requestIdsFor} of every id, flattened — all request aliases are echoed. */
export function requestIdsOf(
  ctx: EventContext,
  ids: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return ids.flatMap((id) => requestIdsFor(ctx, id));
}

/**
 * Validates the body's `ids` against the action table's identifications. For
 * the controller's own table that is its `idSource` (since 0.1.134): a unique
 * index over a field `hasField` hides neither addresses a row nor appears in
 * the "must exactly match one of" message. An `opts.table` binding has no
 * visibility hook. The controller's `prepareRequest` (since 0.1.143) runs
 * first, so the visibility the ids are validated against is the request's.
 * Then, when the controller overrides `resolveRowIds` (since 0.1.148), the
 * validated ids go through it — a one-element array for a `'row'` action —
 * and the resolved ids (duplicates collapsed) are what every consumer sees.
 */
async function resolveValidatedId(
  ctx: EventContext,
  level: "row" | "rows",
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
  const scoped = ctx.get(scopedControllerSlot);
  const resolve = scoped?.[ROW_RESOLVES] ? scoped[ROW_RESOLVE_IDS] : undefined;
  if (!resolve) return env.ids;

  const requested = (level === "row" ? [env.ids] : env.ids) as Record<string, unknown>[];
  const overlay = await ctx.get(dbActionOverlaySlot);
  const { ids, requestIds } = await resolve.call(scoped, requested, {
    purpose: "action",
    action: readCurrentActionMeta(ctx)?.name,
    level,
    overlay: overlay ?? undefined,
  });
  if (requestIds) ctx.set(dbActionRequestIdsKey, requestIds);
  return level === "row" ? ids[0] : ids;
}

export const dbActionIdSlot = cached<Promise<Record<string, unknown>>>(
  (ctx) => resolveValidatedId(ctx, "row", validateSingleId) as Promise<Record<string, unknown>>,
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
  const result = await resolveValidatedId(ctx, "rows", (body, src) =>
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
