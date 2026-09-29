import { getPath } from "./object";

/** String form of a key value (an ObjectId stringifies to its hex, a bigint to its digits). */
export function keyString(value: unknown): string {
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
