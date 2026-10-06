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
import { identityKey, type TRequestedId } from "./rows-by-id";
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
 * EVERY id the client sent, in request order, with the identity of the id it
 * resolved to (since 0.1.148) — set only when the controller's
 * `resolveRowIds` changed or collapsed an id. The single model: refusals,
 * `reasons`, summaries and counts are judged and reported per request id
 * through {@link echoRequests}; the resolved (deduped) ids serve only the
 * row load and the handler.
 */
export const dbActionRequestIdsKey = key<readonly TRequestedId[]>("atscript_db_action_request_ids");

/** Number of request ids (`fallback` when no id was resolved to another). */
export function requestCount(ctx: EventContext, fallback: number): number {
  return ctx.has(dbActionRequestIdsKey) ? ctx.get(dbActionRequestIdsKey).length : fallback;
}

/** Number of request ids that resolved to one of `ids` (`ids.length` when none was rewritten). */
export function requestCountOf(ctx: EventContext, ids: readonly Record<string, unknown>[]): number {
  if (!ctx.has(dbActionRequestIdsKey)) return ids.length;
  const keys = new Set(ids.map((id) => identityKey(id)));
  return ctx.get(dbActionRequestIdsKey).filter((r) => keys.has(r.key)).length;
}

/**
 * Entries keyed by a resolved id, reported for every REQUEST id that resolved
 * to it — in request order, each as the client sent it (`id` replaced). Two
 * aliases of one row come back exactly like two distinct rows (same order,
 * same count). Entries whose id no request resolved to stay as they are,
 * after the request ones.
 */
export function echoRequests<E extends { id: Record<string, unknown> }>(
  ctx: EventContext,
  entries: readonly E[],
): E[] {
  if (!ctx.has(dbActionRequestIdsKey)) return [...entries];
  const byKey = new Map<string, E>();
  const rest: E[] = [];
  for (const e of entries) {
    const k = identityKey(e.id);
    if (k === undefined) rest.push(e);
    else if (!byKey.has(k)) byKey.set(k, e);
  }
  const out: E[] = [];
  const matched = new Set<string>();
  for (const r of ctx.get(dbActionRequestIdsKey)) {
    const e = byKey.get(r.key);
    if (!e) continue;
    matched.add(r.key);
    out.push({ ...e, id: r.id });
  }
  for (const [k, e] of byKey) if (!matched.has(k)) rest.push(e);
  return [...out, ...rest];
}

/** The id as the client sent it (the first, for an id several requests resolved to). */
export function requestIdOf(
  ctx: EventContext,
  id: Record<string, unknown>,
): Record<string, unknown> {
  return echoRequests(ctx, [{ id }])[0]!.id;
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
  const { ids, requests } = await resolve.call(scoped, requested, {
    purpose: "action",
    action: readCurrentActionMeta(ctx)?.name,
    level,
    overlay: overlay ?? undefined,
  });
  if (requests) ctx.set(dbActionRequestIdsKey, requests);
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
