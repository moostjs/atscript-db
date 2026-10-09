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

/** One id the client sent, with the {@link identityKey} of the id it resolved to. */
export interface TRequestedId {
  id: Record<string, unknown>;
  key: string;
}

/**
 * The result of a `resolveRowIds` call over an action's ids: the resolved
 * ids with duplicate identities collapsed to the first (what handlers and
 * the row load see) and — only when an id changed or collapsed — EVERY
 * request id in request order (`requests`), the single model all refusals,
 * reasons, summaries and counts are judged and reported in.
 */
export interface TAppliedIds {
  ids: Record<string, unknown>[];
  requests?: readonly TRequestedId[];
}

/**
 * `resolved` (index-aligned with `requested`) with duplicate identities
 * collapsed to the first, plus the per-request list ({@link TAppliedIds}).
 */
export function applyResolvedIds(
  requested: readonly Record<string, unknown>[],
  resolved: readonly Record<string, unknown>[],
): TAppliedIds {
  const ids: Record<string, unknown>[] = [];
  const requests: TRequestedId[] = [];
  const seen = new Set<string>();
  let changed = false;
  for (let i = 0; i < resolved.length; i++) {
    const k = identityKey(resolved[i]);
    if (k === undefined) {
      ids.push(resolved[i]);
      continue;
    }
    if (k !== identityKey(requested[i])) changed = true;
    requests.push({ id: requested[i], key: k });
    if (seen.has(k)) {
      changed = true; // a duplicate identity collapses to the first; its request is still reported
      continue;
    }
    seen.add(k);
    ids.push(resolved[i]);
  }
  return changed ? { ids, requests } : { ids };
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
 * Sorted field lists per raw key order — every id of one shape sorts its keys
 * once per call, not once per id.
 */
class IdShapes {
  /** Raw key order (`Object.keys` joined) → the sorted fields. */
  private readonly byRaw = new Map<string, readonly string[]>();
  /** Sorted signature → the sorted fields (one entry per distinct shape). */
  readonly bySorted = new Map<string, readonly string[]>();

  fieldsOf(id: Record<string, unknown>): readonly string[] {
    const keys = Object.keys(id);
    const raw = `${keys.length}:${keys.join("\x1f")}`;
    let sorted = this.byRaw.get(raw);
    if (sorted === undefined) {
      const own = keys.length > 1 ? keys.toSorted() : keys;
      const sig = `${own.length}:${own.join("\x1f")}`;
      sorted = this.bySorted.get(sig);
      if (sorted === undefined) this.bySorted.set(sig, (sorted = own));
      this.byRaw.set(raw, sorted);
    }
    return sorted;
  }
}

/** A value `$in` matches exactly like the equality `{ field: value }` on every adapter. */
function isInSafe(value: unknown): boolean {
  const type = typeof value;
  return (
    type === "string" ||
    type === "bigint" ||
    type === "boolean" ||
    (type === "number" && Number.isFinite(value as number))
  );
}

/**
 * The filter matching any of `ids` (deduped): `{ field: { $in } }` when they
 * share one single-field shape with scalar values (one equality for a single
 * id), else `{ $or: ids }`.
 */
function idsFilter(ids: readonly Record<string, unknown>[], shapes: IdShapes): FilterExpr {
  if (ids.length > 0 && shapes.bySorted.size === 1) {
    const [fields] = shapes.bySorted.values();
    if (fields!.length === 1) {
      const field = fields![0]!;
      const values: unknown[] = [];
      for (const id of ids) {
        const value = id[field];
        if (!isInSafe(value)) return { $or: ids } as FilterExpr;
        values.push(value);
      }
      return (
        values.length === 1 ? { [field]: values[0] } : { [field]: { $in: values } }
      ) as FilterExpr;
    }
  }
  return { $or: ids } as FilterExpr;
}

/**
 * The rows `ids` address that also match `scope` (none = every row),
 * aligned with `ids` — `undefined` where nothing matched. One `findMany`
 * over the deduped ids (`{ field: { $in } }` for single-field ids, else
 * `{ $or: ids }`; AND `scope`) selecting `select` plus every id field; ids of
 * different identification shapes may be mixed. The action row loader and
 * `$actions` scope check share it.
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
  const shapes = new IdShapes();
  const idKeys: Array<string | undefined> = [];

  for (const id of ids) {
    const sortedFields = shapes.fieldsOf(id);
    const key = idKey(id, sortedFields);
    idKeys.push(key);
    if (key !== undefined && !seenKeys.has(key)) {
      seenKeys.add(key);
      dedupedIds.push(id);
    }
  }
  for (const sortedFields of shapes.bySorted.values()) {
    for (const f of sortedFields) fields.add(f);
  }

  const match = idsFilter(dedupedIds, shapes);
  const rows = await source.findMany({
    filter: scope ? { $and: [match, scope] } : match,
    controls: { $select: [...fields] },
  });
  return alignByKeys(rows, idKeys, shapes);
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
  const shapes = new IdShapes();
  const idKeys = ids.map((id) => idKey(id, shapes.fieldsOf(id)));
  return alignByKeys(rows, idKeys, shapes);
}

function alignByKeys(
  rows: readonly Record<string, unknown>[],
  idKeys: readonly (string | undefined)[],
  shapes: IdShapes,
): Array<Record<string, unknown> | undefined> {
  const rowByKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    for (const sortedFields of shapes.bySorted.values()) {
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

/**
 * `row` without its own `keys` — a NEW object (same key order) when it has
 * any of them, else `row` itself. Rows are rebuilt rather than `delete`d
 * from: a deleted key turns an object into a slow dictionary-mode one for
 * everything after (decoration, serialization).
 */
export function omitKeys(
  row: Record<string, unknown>,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  let has = false;
  for (const key of keys) {
    if (Object.hasOwn(row, key)) {
      has = true;
      break;
    }
  }
  if (!has) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    if (keys.has(key)) continue;
    if (key === "__proto__") {
      Object.defineProperty(out, key, {
        value: row[key],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      out[key] = row[key];
    }
  }
  return out;
}

/** Field paths split once for {@link projectRow} over many rows. */
export type TSplitPaths = readonly (readonly string[])[];

/** `fields` split at the dots — pass to {@link projectRow} when projecting many rows. */
export function splitPaths(fields: Iterable<string>): TSplitPaths {
  const out: string[][] = [];
  for (const path of fields) out.push(path.split("."));
  return out;
}

/** `row` narrowed to `fields` (dot paths copied into fresh nested objects). */
export function projectRow(
  row: Record<string, unknown>,
  fields: Iterable<string> | TSplitPaths,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of fields) {
    const parts = typeof path === "string" ? path.split(".") : path;
    let src: unknown = row;
    for (const p of parts) src = (src as Record<string, unknown> | null | undefined)?.[p];
    if (src === undefined) continue;
    let dst = out;
    for (let i = 0; i < parts.length - 1; i++) {
      dst = (dst[parts[i]!] ??= {}) as Record<string, unknown>;
    }
    dst[parts.at(-1)!] = src;
  }
  return out;
}
