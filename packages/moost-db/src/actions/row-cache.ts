import { cached, defineWook, type EventContext } from "@wooksjs/event-core";
import { HttpError } from "@moostjs/event-http";

import { getActionTable, noTableError } from "./controller-access";
import { readCurrentActionMeta } from "./current-action";
import { dbActionIdSlot, dbActionIdsSlot } from "./id-cache";
import { dbActionQueryTargetSlot, dbActionStaleKey } from "./query-target";
import {
  actionFieldVisibility,
  applyActionScope,
  dbActionOverlaySlot,
  withOverlay,
} from "./row-scope";
import { actionRowFields, findRowsByIds, requiredFieldsOf } from "./rows-by-id";

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
 * Loaded row / rows are ANDed with the controller's row overlay (see
 * `dbActionOverlaySlot`, since 0.1.143) and, since 0.1.147, checked against
 * the action's `actionRowScope` for the loaded candidates: an out-of-scope id
 * loads nothing — exactly like a missing one (the same 404 on `'row'`
 * actions, so the two can't be told apart).
 *
 * Order: `prepareRequest` → the row overlay (BEFORE the request body is
 * read: fail-fast authorization) → the ids (body) → the row load →
 * `actionRowScope` (it needs the candidates).
 */
async function loadRow(ctx: EventContext): Promise<unknown> {
  const overlay = await ctx.get(dbActionOverlaySlot);
  const id = (await ctx.get(dbActionIdSlot)) as Record<string, unknown>;
  const table = asFetchTable(getActionTable(ctx));
  if (!table) throw noTableError(ctx);

  const fields = seedActionFields(ctx, table);
  for (const k of Object.keys(id)) fields.add(k);

  const loaded = await table.findOne({
    filter: withOverlay(id, overlay),
    controls: { $select: [...fields] },
  });
  const [row] = loaded == null ? [undefined] : await applyActionScope(ctx, table, [loaded]);
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
