import { cached, defineWook, type EventContext } from "@wooksjs/event-core";
import { HttpError } from "@moostjs/event-http";

import { readCurrentActionMeta } from "./current-action";
import { dbActionIdSlot, dbActionIdsSlot, getActionTable, noTableError } from "./id-cache";
import { actionFieldVisibility, dbActionOverlaySlot, withOverlay } from "./row-scope";
import { actionRowFields, findRowsByIds, requiredFieldsOf } from "./rows-by-id";

interface RowFetchTable {
  primaryKeys: readonly string[];
  preferredId?: readonly string[];
  findOne(query: { filter: unknown; controls?: unknown }): Promise<Record<string, unknown> | null>;
  findMany(query: { filter: unknown; controls?: unknown }): Promise<Record<string, unknown>[]>;
}

function asFetchTable(value: unknown): RowFetchTable | null {
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
function seedActionFields(ctx: EventContext, table: RowFetchTable): Set<string> {
  const required = requiredFieldsOf(readCurrentActionMeta(ctx)?.opts);
  return actionRowFields(table, required, actionFieldVisibility(ctx));
}

/**
 * Loaded row / rows are ANDed with the controller's row overlay (see
 * `dbActionOverlaySlot`, since 0.1.143): an out-of-scope id loads nothing —
 * exactly like a missing one (the same 404 on `'row'` actions, so the two
 * can't be told apart).
 *
 * The overlay resolves BEFORE the ids — i.e. before the request body is
 * read. Moost's HTTP adapter releases the event's DI scope when the request
 * stream ends, so a `transformFilter` / `transformOne` that instantiates a
 * `FOR_EVENT` dependency (an ARBAC user provider) fails with "scope isn't
 * registered" once the body has been consumed.
 */
async function loadRow(ctx: EventContext): Promise<unknown> {
  const overlay = await ctx.get(dbActionOverlaySlot);
  const id = (await ctx.get(dbActionIdSlot)) as Record<string, unknown>;
  const table = asFetchTable(getActionTable(ctx));
  if (!table) throw noTableError(ctx);

  const fields = seedActionFields(ctx, table);
  for (const k of Object.keys(id)) fields.add(k);

  const row = await table.findOne({
    filter: withOverlay(id, overlay),
    controls: { $select: [...fields] },
  });
  if (row == null) {
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
  return findRowsByIds(table, ids, overlay, seedActionFields(ctx, table));
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
