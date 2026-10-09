import { getPath } from "./object";

/**
 * String form of a key value, equal across driver representations: an
 * ObjectId stringifies to its hex, a bigint to its digits, a Date to its ISO
 * instant, a Buffer / Uint8Array to hex.
 */
export function keyString(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return String(value as string | number | { toString(): string });
}

/** Key equality across driver representations (number vs numeric string, ObjectId vs hex). */
export function sameKey(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return keyString(a) === keyString(b);
}

/**
 * One string identity for the key tuple `fields` of `row` (dot-paths read
 * nested) — equal for equal keys across driver representations. Used to
 * dedupe / match rows by primary key in memory.
 */
export function pkTupleKey(row: Record<string, unknown>, fields: readonly string[]): string {
  let out = "";
  for (let i = 0; i < fields.length; i++) {
    if (i > 0) out += "\0";
    out += keyString(getPath(row, fields[i]!));
  }
  return out;
}

/** Whether `row` carries exactly the values of an equality filter `{ field: value, … }`. */
export function rowMatchesKey(row: Record<string, unknown>, key: Record<string, unknown>): boolean {
  for (const field in key) {
    if (!sameKey(getPath(row, field), key[field])) return false;
  }
  return true;
}

/**
 * Identity of the key tuple `fields` of `row` for uniqueness checks, or
 * `undefined` when any component is null / missing (a NULL never collides).
 * Equal across driver representations (see {@link keyString}).
 */
export function uniqueKeyTuple(
  row: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  const parts: string[] = [];
  for (const field of fields) {
    const value = getPath(row, field);
    if (value === undefined || value === null) return undefined;
    parts.push(keyString(value));
  }
  return JSON.stringify(parts);
}

/**
 * For every equality `filters[i]`, the FIRST row of `rows` that
 * {@link rowMatchesKey} matches it — `rows.find(…)` per filter, answered from
 * one hash index per distinct filter key set instead of a scan per filter.
 * A filter holding a `null` / `undefined` value (where {@link sameKey}
 * differs from string identity) is matched by the scan. `undefined` = no row.
 * @since 0.1.151
 */
export function findRowsByKeys<R extends Record<string, unknown>>(
  rows: readonly R[],
  filters: ReadonlyArray<Record<string, unknown>>,
): Array<R | undefined> {
  const out: Array<R | undefined> = Array.from({ length: filters.length });
  // Tiny inputs: the scan is cheaper than building an index.
  if (rows.length * filters.length <= 64) {
    for (let i = 0; i < filters.length; i++) {
      out[i] = rows.find((r) => rowMatchesKey(r, filters[i]!));
    }
    return out;
  }
  const indexes = new Map<string, Map<string, R>>();
  for (let i = 0; i < filters.length; i++) {
    const filter = filters[i]!;
    const fields = Object.keys(filter);
    let indexable = fields.length > 0;
    for (const field of fields) {
      const value = filter[field];
      if (value === null || value === undefined) {
        indexable = false;
        break;
      }
    }
    if (!indexable) {
      out[i] = rows.find((r) => rowMatchesKey(r, filter));
      continue;
    }
    const signature = JSON.stringify(fields);
    let index = indexes.get(signature);
    if (index === undefined) {
      index = new Map();
      for (const row of rows) {
        const key = keyTupleString(row, fields);
        // First row wins — what `rows.find` returns.
        if (key !== undefined && !index.has(key)) index.set(key, row);
      }
      indexes.set(signature, index);
    }
    out[i] = index.get(keyTupleString(filter, fields, true)!);
  }
  return out;
}

/**
 * The {@link keyString} tuple of `fields` of `source` (dot-paths read nested
 * for a row, plain keys for a filter); `undefined` when a component is null /
 * missing (it can only equal a null filter value, which is never indexed).
 */
function keyTupleString(
  source: Record<string, unknown>,
  fields: readonly string[],
  plain = false,
): string | undefined {
  if (fields.length === 1) {
    const value = plain ? source[fields[0]!] : getPath(source, fields[0]!);
    return value === null || value === undefined ? undefined : keyString(value);
  }
  const parts: string[] = [];
  for (const field of fields) {
    const value = plain ? source[field] : getPath(source, field);
    if (value === null || value === undefined) return undefined;
    parts.push(keyString(value));
  }
  return JSON.stringify(parts);
}
