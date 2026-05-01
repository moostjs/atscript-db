import { cached, defineWook, type EventContext } from "@wooksjs/event-core";
import { HttpError } from "@moostjs/event-http";

import { WARN_PREFIX } from "./keys";
import { dbActionPkSlot, dbActionPksSlot, getActionTable } from "./pk-cache";

interface RowFetchTable {
  primaryKeys: readonly string[];
  findById(id: unknown): Promise<unknown>;
  findMany(query: { filter: unknown; controls?: unknown }): Promise<unknown[]>;
}

function asFetchTable(value: unknown): RowFetchTable | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<RowFetchTable>;
  return Array.isArray(v.primaryKeys) &&
    typeof v.findById === "function" &&
    typeof v.findMany === "function"
    ? (v as RowFetchTable)
    : null;
}

function noTable(): never {
  throw new HttpError(500, `${WARN_PREFIX} cached row wook: no bound table`);
}

async function loadRow(ctx: EventContext): Promise<unknown> {
  const pk = await ctx.get(dbActionPkSlot);
  const table = asFetchTable(getActionTable(ctx)) ?? noTable();
  const row = await table.findById(pk);
  if (row == null) {
    throw new HttpError(404, "Row not found for action PK");
  }
  return row;
}

async function loadRows(ctx: EventContext): Promise<unknown[]> {
  const pks = (await ctx.get(dbActionPksSlot)) as unknown[];
  const table = asFetchTable(getActionTable(ctx)) ?? noTable();
  if (pks.length === 0) return [];
  const { primaryKeys } = table;
  const rows = await table.findMany({ filter: buildPksFilter(pks, primaryKeys) });
  // Preserve request order so ActionDisabledError.pks matches client-supplied order.
  if (primaryKeys.length === 1) {
    const field = primaryKeys[0];
    const byKey = new Map<unknown, unknown>();
    for (const row of rows) byKey.set((row as Record<string, unknown>)[field], row);
    const ordered: unknown[] = [];
    for (const pk of pks) {
      const found = byKey.get(pk);
      if (found !== undefined) ordered.push(found);
    }
    return ordered;
  }
  const byKey = new Map<string, unknown>();
  for (const row of rows) byKey.set(compositeKey(row as Record<string, unknown>, primaryKeys), row);
  const ordered: unknown[] = [];
  for (const pk of pks) {
    const found = byKey.get(compositeKey(pk as Record<string, unknown>, primaryKeys));
    if (found !== undefined) ordered.push(found);
  }
  return ordered;
}

function buildPksFilter(pks: unknown[], primaryKeys: readonly string[]): unknown {
  if (primaryKeys.length === 1) {
    return { [primaryKeys[0]]: { $in: pks } };
  }
  return {
    $or: pks.map((pk) => {
      const obj = pk as Record<string, unknown>;
      const clause: Record<string, unknown> = {};
      for (const field of primaryKeys) clause[field] = obj[field];
      return clause;
    }),
  };
}

function compositeKey(obj: Record<string, unknown>, primaryKeys: readonly string[]): string {
  let out = "";
  for (const f of primaryKeys) {
    if (out !== "") out += "\x00";
    const v = obj[f];
    if (v === null) out += "\x01n";
    else if (v === undefined) out += "\x01u";
    else if (typeof v === "string") out += `s\x02${v}`;
    else if (typeof v === "number") out += `n\x02${v}`;
    else if (typeof v === "boolean") out += `b\x02${v}`;
    else out += `j\x02${JSON.stringify(v)}`;
  }
  return out;
}

export const dbActionRowSlot = cached<Promise<unknown>>((ctx) => loadRow(ctx));

// Gate's skip mode overwrites this slot via ctx.set with the survivors.
export const dbActionRowsSlot = cached<Promise<unknown[]>>((ctx) => loadRows(ctx));

export const useDbActionRow = defineWook((ctx) => ({
  load: () => ctx.get(dbActionRowSlot),
}));

export const useDbActionRows = defineWook((ctx) => ({
  load: () => ctx.get(dbActionRowsSlot),
}));
