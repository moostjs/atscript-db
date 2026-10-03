import type { FilterExpr } from "@atscript/db";

/** The one read {@link findRowsByIds} needs from a table / view. */
export interface TRowsByIdSource {
  findMany(query: { filter: unknown; controls?: unknown }): Promise<Record<string, unknown>[]>;
}

function stringifyScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return String(value as string | number | boolean | bigint);
}

/**
 * The identity of `id`'s values over `fields` (sorted) — equal for equal
 * keys across driver representations (a number vs its string, an ObjectId
 * vs its hex). `undefined` when `row` lacks one of the fields.
 */
export function idKey(row: Record<string, unknown>, fields: readonly string[]): string | undefined {
  let key = "";
  for (const f of fields) {
    const v = row[f];
    if (v === undefined) return undefined;
    key += `${f}\x1f${stringifyScalar(v)}\x1e`;
  }
  return key;
}

/** {@link idKey} of an identity over its own fields. */
export function identityKey(id: Record<string, unknown>): string | undefined {
  return idKey(id, Object.keys(id).toSorted());
}

/**
 * The deduped identities of `rows` over `fields` — a value read by `read`
 * (default: the row's own field) — and, per row, its identity's index in
 * `ids` (`-1`: the row is absent, or a value is missing / null).
 */
export function dedupeIdentities(
  rows: readonly (Record<string, unknown> | undefined)[],
  fields: readonly string[],
  read: (row: Record<string, unknown>, field: string) => unknown = (row, f) => row[f],
): { ids: Record<string, unknown>[]; index: number[] } {
  const ids: Record<string, unknown>[] = [];
  const index: number[] = [];
  const byKey = new Map<string, number>();
  const sorted = fields.toSorted();
  for (const row of rows) {
    const id = row && fields.length > 0 ? identityOf(row, fields, read) : undefined;
    const k = id && idKey(id, sorted);
    if (k === undefined) {
      index.push(-1);
      continue;
    }
    let at = byKey.get(k);
    if (at === undefined) {
      at = ids.push(id!) - 1;
      byKey.set(k, at);
    }
    index.push(at);
  }
  return { ids, index };
}

function identityOf(
  row: Record<string, unknown>,
  fields: readonly string[],
  read: (row: Record<string, unknown>, field: string) => unknown,
): Record<string, unknown> | undefined {
  const id: Record<string, unknown> = {};
  for (const f of fields) {
    const value = read(row, f);
    if (value === undefined || value === null) return undefined;
    id[f] = value;
  }
  return id;
}

/**
 * The rows `ids` address that also match `scope` (none = every row),
 * aligned with `ids` — `undefined` where nothing matched. One `findMany`
 * over the deduped ids (`{ $or: ids } AND scope`) selecting `select` plus
 * every id field; ids of different identification shapes may be mixed.
 * The action row loader and `$actions` scope check share it.
 */
export async function findRowsByIds(
  source: TRowsByIdSource,
  ids: readonly Record<string, unknown>[],
  scope: FilterExpr | null | undefined,
  select: Iterable<string>,
): Promise<Array<Record<string, unknown> | undefined>> {
  if (ids.length === 0) return [];
  const fields = new Set(select);
  const dedupedIds: Record<string, unknown>[] = [];
  const seenKeys = new Set<string>();

  for (const id of ids) {
    const sortedFields = Object.keys(id).toSorted();
    for (const f of sortedFields) fields.add(f);
    const key = idKey(id, sortedFields);
    if (key !== undefined && !seenKeys.has(key)) {
      seenKeys.add(key);
      dedupedIds.push(id);
    }
  }

  const rows = await source.findMany({
    filter: scope ? { $and: [{ $or: dedupedIds }, scope] } : { $or: dedupedIds },
    controls: { $select: [...fields] },
  });
  return alignRowsToIds(rows, ids);
}

/**
 * `rows` aligned with `ids` — per id, the first row with its key values
 * ({@link idKey}), `undefined` when none has them. Ids of different
 * identification shapes may be mixed.
 */
export function alignRowsToIds(
  rows: readonly Record<string, unknown>[],
  ids: readonly Record<string, unknown>[],
): Array<Record<string, unknown> | undefined> {
  const shapes = new Map<string, readonly string[]>();
  const idKeys: Array<string | undefined> = [];
  for (const id of ids) {
    const sortedFields = Object.keys(id).toSorted();
    const sig = sortedFields.join("\x1f");
    if (!shapes.has(sig)) shapes.set(sig, sortedFields);
    idKeys.push(idKey(id, sortedFields));
  }
  const rowByKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    for (const sortedFields of shapes.values()) {
      const key = idKey(row, sortedFields);
      if (key !== undefined && !rowByKey.has(key)) rowByKey.set(key, row);
    }
  }
  return idKeys.map((key) => (key === undefined ? undefined : rowByKey.get(key)));
}

/** The `requiredFields` of action opts (`@DbAction` opts or a discovered envelope's raw entry). */
export function requiredFieldsOf(opts: unknown): readonly string[] {
  const fields = (opts as { requiredFields?: unknown } | undefined)?.requiredFields;
  return Array.isArray(fields) ? (fields as string[]) : [];
}

/**
 * Id columns (`preferredId`, else the primary key) plus `requiredFields` —
 * minus any `isVisible` hides (since 0.1.143; `hasField`, and a derived
 * field over a hidden source): a hidden column is never loaded, so a
 * `disabled` predicate sees it as `undefined`. What an action's gate loads.
 */
export function actionRowFields(
  table: { primaryKeys: readonly string[]; preferredId?: readonly string[] },
  requiredFields: readonly string[],
  isVisible: ((path: string) => boolean) | undefined,
): Set<string> {
  const fields = new Set<string>(table.preferredId ?? table.primaryKeys);
  for (const f of requiredFields) if (!isVisible || isVisible(f)) fields.add(f);
  return fields;
}

/** `true` when `row` carries a top-level key outside `fields` (projecting it would drop something). */
export function exceedsFields(row: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  for (const key in row) if (!fields.has(key)) return true;
  return false;
}

/** `row` narrowed to `fields` (dot paths copied into fresh nested objects). */
export function projectRow(
  row: Record<string, unknown>,
  fields: Iterable<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of fields) {
    const parts = path.split(".");
    let src: unknown = row;
    for (const p of parts) src = (src as Record<string, unknown> | null | undefined)?.[p];
    if (src === undefined) continue;
    let dst = out;
    for (let i = 0; i < parts.length - 1; i++) {
      dst = (dst[parts[i]] ??= {}) as Record<string, unknown>;
    }
    dst[parts.at(-1)!] = src;
  }
  return out;
}
