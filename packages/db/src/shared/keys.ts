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
