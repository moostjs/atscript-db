import { cached, defineWook, type EventContext } from "@wooksjs/event-core";
import { HttpError } from "@moostjs/event-http";

import { dbActionIdSlot, dbActionIdsSlot, getActionTable, noTableError } from "./id-cache";

interface RowFetchTable {
  primaryKeys: readonly string[];
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

function stringifyScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return String(value as string | number | boolean | bigint);
}

async function loadRow(ctx: EventContext): Promise<unknown> {
  const id = await ctx.get(dbActionIdSlot);
  const table = asFetchTable(getActionTable(ctx));
  if (!table) throw noTableError(ctx);
  const row = await table.findOne({ filter: id });
  if (row == null) {
    throw new HttpError(404, "Row not found for action identifier");
  }
  return row;
}

async function loadRows(ctx: EventContext): Promise<Array<Record<string, unknown> | undefined>> {
  const ids = (await ctx.get(dbActionIdsSlot)) as Record<string, unknown>[];
  const table = asFetchTable(getActionTable(ctx));
  if (!table) throw noTableError(ctx);
  if (ids.length === 0) return [];

  const fields = new Set<string>();
  const idKeys: string[] = [];
  const shapes = new Map<string, readonly string[]>();
  const dedupedIds: Record<string, unknown>[] = [];
  const seenKeys = new Set<string>();

  for (const id of ids) {
    const sortedFields = Object.keys(id).toSorted();
    const sig = sortedFields.join("\x1f");
    let key = "";
    for (const f of sortedFields) {
      fields.add(f);
      key += `${f}\x1f${stringifyScalar(id[f])}\x1e`;
    }
    idKeys.push(key);
    if (!shapes.has(sig)) shapes.set(sig, sortedFields);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      dedupedIds.push(id);
    }
  }

  const rows = await table.findMany({
    filter: { $or: dedupedIds },
    controls: { $select: [...fields] },
  });

  const rowByKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    for (const sortedFields of shapes.values()) {
      let key = "";
      let ok = true;
      for (const f of sortedFields) {
        const v = row[f];
        if (v === undefined) {
          ok = false;
          break;
        }
        key += `${f}\x1f${stringifyScalar(v)}\x1e`;
      }
      if (ok && !rowByKey.has(key)) rowByKey.set(key, row);
    }
  }

  return ids.map((_, i) => rowByKey.get(idKeys[i]));
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
