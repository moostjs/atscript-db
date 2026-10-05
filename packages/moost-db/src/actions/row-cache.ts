import { cached, defineWook, type EventContext } from "@wooksjs/event-core";
import { HttpError } from "@moostjs/event-http";
import type { FilterExpr } from "@atscript/db";

import { getActionTable, noTableError } from "./controller-access";
import { readCurrentActionMeta } from "./current-action";
import { dbActionIdSlot, dbActionIdsSlot } from "./id-cache";
import { dbActionQueryTargetSlot, dbActionStaleKey } from "./query-target";
import {
  ACTION_SCOPE,
  ACTION_SCOPED,
  actionFieldVisibility,
  applyActionScope,
  dbActionOverlaySlot,
  nonEmptyFilter,
  scopedControllerSlot,
  withOverlay,
} from "./row-scope";
import { createScopeContext } from "./scope-context";
import { actionRowFields, dedupeIdentities, findRowsByIds, requiredFieldsOf } from "./rows-by-id";

/** The table surface the action row loaders read through. */
export interface RowFetchTable {
  primaryKeys: readonly string[];
  preferredId?: readonly string[];
  findOne(query: { filter: unknown; controls?: unknown }): Promise<Record<string, unknown> | null>;
  findMany(query: { filter: unknown; controls?: unknown }): Promise<Record<string, unknown>[]>;
}

export function asFetchTable(value: unknown): RowFetchTable | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<RowFetchTable>;
  if (
    Array.isArray(v.primaryKeys) &&
    typeof v.findOne === "function" &&
    typeof v.findMany === "function"
  ) {
    return v as RowFetchTable;
  }
  return null;
}

/**
 * What this action's gate loads: {@link actionRowFields} of its
 * `requiredFields` (none outside a controller context, e.g. direct wook
 * usage in tests) under the controller's field visibility.
 */
export function seedActionFields(ctx: EventContext, table: RowFetchTable): Set<string> {
  const required = requiredFieldsOf(readCurrentActionMeta(ctx)?.opts);
  return actionRowFields(table, required, actionFieldVisibility(ctx));
}

/**
 * The action's `actionRowScope` asked BEFORE any row is loaded (since
 * 0.1.148):
 *
 * - `resolved`: `scope` is the hook's answer for the request's ids
 *   (`null` = unrestricted, or the controller has no hook) — folded into the
 *   one row load, and `applyActionScope` is not called again;
 * - `deferred`: the hook needs the loaded candidates (a row overlay exists,
 *   the ids are not in `preferredId` shape, a query target) — the
 *   candidate-aware path of 0.1.147.
 */
export type TPreScope = { kind: "deferred" } | { kind: "resolved"; scope: FilterExpr | null };

const UNSCOPED: TPreScope = { kind: "resolved", scope: null };
const DEFERRED: TPreScope = { kind: "deferred" };

function inPreferredShape(
  ids: readonly Record<string, unknown>[],
  preferred: readonly string[],
): boolean {
  return ids.every((id) => {
    const keys = Object.keys(id);
    return keys.length === preferred.length && preferred.every((f) => f in id);
  });
}

async function resolvePreScope(ctx: EventContext, level: "row" | "rows"): Promise<TPreScope> {
  const ctrl = ctx.get(scopedControllerSlot);
  const action = readCurrentActionMeta(ctx)?.name;
  const scopeOf = ctrl?.[ACTION_SCOPED] ? ctrl[ACTION_SCOPE] : undefined;
  if (!ctrl || !scopeOf || action === undefined) return UNSCOPED;
  // The overlay first: an authorization failure precedes any body read.
  if (await ctx.get(dbActionOverlaySlot)) return DEFERRED;
  const table = asFetchTable(getActionTable(ctx));
  const preferred = table?.preferredId;
  if (!table || !preferred?.length) return DEFERRED;
  const [target, requested] = await Promise.all([
    level === "rows" ? ctx.get(dbActionQueryTargetSlot) : undefined,
    level === "row" ? ctx.get(dbActionIdSlot).then((id) => [id]) : ctx.get(dbActionIdsSlot),
  ]);
  if (target || !inPreferredShape(requested, preferred)) return DEFERRED;
  // A `'row'` action has one id; `'rows'` ids may repeat an identity.
  const ids = level === "row" ? requested : dedupeIdentities(requested, preferred).ids;
  // No id: no hook call — nothing to scope.
  if (ids.length === 0) return UNSCOPED;
  const scope = nonEmptyFilter(
    await scopeOf.call(ctrl, action, createScopeContext("execute", ids, table)),
  );
  return { kind: "resolved", scope: scope ?? null };
}

/**
 * {@link TPreScope} of the current action — once per event. An event runs one
 * action, so the first caller's `level` (`'row'` / `'rows'`) is the action's.
 */
export const dbActionPreScopeSlot = cached<(level: "row" | "rows") => Promise<TPreScope>>((ctx) => {
  let pending: Promise<TPreScope> | undefined;
  return (level) => (pending ??= resolvePreScope(ctx, level));
});

/**
 * Loaded row / rows are ANDed with the controller's row overlay (see
 * `dbActionOverlaySlot`, since 0.1.143) and, since 0.1.147, checked against
 * the action's `actionRowScope`: an out-of-scope id loads nothing — exactly
 * like a missing one (the same 404 on `'row'` actions, so the two can't be
 * told apart).
 *
 * Order: `prepareRequest` → the row overlay (BEFORE the request body is
 * read: fail-fast authorization) → the ids (body) → `resolveRowIds` (since
 * 0.1.148) → `actionRowScope` (pre-load, when there is no overlay and the
 * ids are in `preferredId` shape — its restriction joins the one row load;
 * since 0.1.148) → the row load → otherwise `actionRowScope` on the loaded
 * candidates (it needs them).
 */
async function loadRow(ctx: EventContext): Promise<unknown> {
  const overlay = await ctx.get(dbActionOverlaySlot);
  const id = (await ctx.get(dbActionIdSlot)) as Record<string, unknown>;
  const table = asFetchTable(getActionTable(ctx));
  if (!table) throw noTableError(ctx);
  const pre = await ctx.get(dbActionPreScopeSlot)("row");

  const fields = seedActionFields(ctx, table);
  for (const k of Object.keys(id)) fields.add(k);

  const idFilter = withOverlay(
    withOverlay(id, overlay),
    pre.kind === "resolved" ? pre.scope : null,
  );
  const loaded = await table.findOne({ filter: idFilter, controls: { $select: [...fields] } });
  let row: Record<string, unknown> | undefined = loaded ?? undefined;
  if (row !== undefined && pre.kind === "deferred") {
    [row] = await applyActionScope(ctx, table, [row]);
  }
  if (row === undefined) {
    throw new HttpError(404, "Row not found for action identifier");
  }
  return row;
}

async function loadRows(ctx: EventContext): Promise<Array<Record<string, unknown> | undefined>> {
  // Overlay before the body — see `loadRow`.
  const overlay = await ctx.get(dbActionOverlaySlot);
  const ids = (await ctx.get(dbActionIdsSlot)) as Record<string, unknown>[];
  const table = asFetchTable(getActionTable(ctx));
  if (!table) throw noTableError(ctx);
  const fields = seedActionFields(ctx, table);
  const target = await ctx.get(dbActionQueryTargetSlot);
  if (!target) {
    const pre = await ctx.get(dbActionPreScopeSlot)("rows");
    if (pre.kind === "resolved") {
      const scope = pre.scope ? withOverlay(pre.scope, overlay) : overlay;
      return findRowsByIds(table, ids, scope, fields);
    }
    return applyActionScope(ctx, table, await findRowsByIds(table, ids, overlay, fields));
  }
  // A query target re-checks its rows against the query it matched them by
  // (filter, search, overlay, `queryTargetScope`, `exclude`): a row that
  // changed out of it is "stale".
  const rows = await target.load(ids, fields);
  const stale = new Set<number>();
  for (let i = 0; i < rows.length; i++) if (rows[i] === undefined) stale.add(i);
  if (stale.size > 0) ctx.set(dbActionStaleKey, stale);
  return applyActionScope(ctx, table, rows);
}

export const dbActionRowSlot = cached<Promise<unknown>>((ctx) => loadRow(ctx));

export const dbActionRowsSlot = cached<Promise<Array<Record<string, unknown> | undefined>>>((ctx) =>
  loadRows(ctx),
);

export const useDbActionRow = defineWook((ctx) => ({
  load: () => ctx.get(dbActionRowSlot),
}));

export const useDbActionRows = defineWook((ctx) => ({
  load: () => ctx.get(dbActionRowsSlot),
}));
