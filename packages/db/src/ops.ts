import { DbError } from "./db-error";

// ── Field operation helpers ──────────────────────────────────────────────────
// Pure functions returning JSON-serializable objects.
// Safe for frontend use — zero runtime dependencies.

/** A numeric field operation (increment, decrement, or multiply). */
export interface TDbFieldOp {
  $inc?: number;
  $dec?: number;
  $mul?: number;
}

/**
 * A compare-and-set assertion: the update applies only if the version
 * column currently equals `value`. Used inline in update payloads:
 *
 *   { ...patch, $cas: { version: 4 } }
 *
 * The map shape is forward-compatible with multi-field CAS; v1 has
 * exactly one entry keyed by the table's version column name.
 */
export interface TDbCas {
  [versionColumn: string]: number;
}

/** Increment a numeric field by `value` (default 1). */
export function $inc(value: number = 1): TDbFieldOp {
  return { $inc: value };
}

/** Decrement a numeric field by `value` (default 1). */
export function $dec(value: number = 1): TDbFieldOp {
  return { $dec: value };
}

/** Multiply a numeric field by `value`. */
export function $mul(value: number): TDbFieldOp {
  return { $mul: value };
}

/**
 * Build a CAS marker for an inline payload.
 *
 * Use as a sibling to plain SET fields in an update payload:
 *
 *   await users.updateOne({ id, status: 'active', ...$cas('version', 4) })
 *
 * The wrapped object can be spread directly so the marker stays a
 * single, type-safe top-level entry.
 */
export function $cas(versionColumn: string, value: number): { $cas: TDbCas } {
  return { $cas: { [versionColumn]: value } };
}

// ── Array operation helpers ─────────────────────────────────────────────────
// Sentinels matching the existing TArrayPatch shape.

/** Replace the entire array. */
export function $replace<T>(items: T[]): { $replace: T[] } {
  return { $replace: items };
}

/** Append items to an array. */
export function $insert<T>(items: T[]): { $insert: T[] } {
  return { $insert: items };
}

/** Insert-or-update items by key. */
export function $upsert<T>(items: T[]): { $upsert: T[] } {
  return { $upsert: items };
}

/** Update existing items matched by key. */
export function $update<T>(items: Partial<T>[]): { $update: Partial<T>[] } {
  return { $update: items };
}

/** Remove items matched by key or value. */
export function $remove<T>(items: Partial<T>[]): { $remove: Partial<T>[] } {
  return { $remove: items };
}

// ── Pre-separated field operations (adapter-facing) ─────────────────────────

/** Pre-separated field operations, ready for adapters. */
export interface TFieldOps {
  inc?: Record<string, number>;
  mul?: Record<string, number>;
}

// ── Detection utilities ─────────────────────────────────────────────────────

/** Returns true if obj has any own key other than `skip`. Zero-allocation. */
function _hasExtraKey(obj: Record<string, unknown>, skip: string): boolean {
  for (const k in obj) {
    if (k !== skip) return true;
  }
  return false;
}

/**
 * Returns `true` when `value` is a field operation object
 * (`{ $inc: N }`, `{ $dec: N }`, or `{ $mul: N }`).
 */
export function isDbFieldOp(value: unknown): value is TDbFieldOp {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if ("$inc" in v) return typeof v.$inc === "number" && !_hasExtraKey(v, "$inc");
  if ("$dec" in v) return typeof v.$dec === "number" && !_hasExtraKey(v, "$dec");
  if ("$mul" in v) return typeof v.$mul === "number" && !_hasExtraKey(v, "$mul");
  return false;
}

/**
 * Extracts the normalized operation from a field op value.
 * Returns `undefined` when `value` is not a field op.
 *
 * `$dec` is normalized to `{ op: 'inc', value: -N }` so consumers
 * only need to handle `inc` and `mul`.
 */
export function getDbFieldOp(value: unknown): { op: "inc" | "mul"; value: number } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.$inc === "number" && !_hasExtraKey(v, "$inc")) return { op: "inc", value: v.$inc };
  if (typeof v.$dec === "number" && !_hasExtraKey(v, "$dec")) return { op: "inc", value: -v.$dec };
  if (typeof v.$mul === "number" && !_hasExtraKey(v, "$mul")) return { op: "mul", value: v.$mul };
  return undefined;
}

/**
 * Separates field operations from a data payload.
 *
 * Mutates `data` in-place (removes op entries) and returns the separated ops.
 * When no ops are found, returns `undefined` — zero allocation for the
 * common non-op case.
 *
 * Hot path: uses `for...in` (no array allocation), inlines detection to
 * avoid intermediate `{ op, value }` objects, and short-circuits on typeof.
 */
export function separateFieldOps(data: Record<string, unknown>): TFieldOps | undefined {
  let ops: TFieldOps | undefined;

  for (const key in data) {
    const value = data[key];
    // Fast path: primitives, null, arrays — skip immediately
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    // Inline field op detection — avoids getDbFieldOp intermediate object
    const v = value as Record<string, unknown>;
    let opValue: number | undefined;
    let opType: 0 | 1 | undefined; // 0 = inc, 1 = mul
    if (typeof v.$inc === "number" && !_hasExtraKey(v, "$inc")) {
      opValue = v.$inc;
      opType = 0;
    } else if (typeof v.$dec === "number" && !_hasExtraKey(v, "$dec")) {
      opValue = -v.$dec;
      opType = 0;
    } else if (typeof v.$mul === "number" && !_hasExtraKey(v, "$mul")) {
      opValue = v.$mul;
      opType = 1;
    }
    if (opType !== undefined) {
      if (!ops) ops = {};
      if (opType === 0) {
        (ops.inc ??= {})[key] = opValue!;
      } else {
        (ops.mul ??= {})[key] = opValue!;
      }
      delete data[key];
    }
  }

  return ops;
}

/**
 * Strips the top-level `$cas` operator from a write payload.
 *
 * Mutates `data` (deletes `$cas`) and returns the extracted expected
 * version, or `undefined` if no `$cas` was present.
 *
 * The caller is expected to know the table's version column name and
 * either trust the lookup or pass it explicitly for validation. v1
 * accepts a single-entry `$cas` map; the returned number is the value
 * of that entry.
 *
 * Errors (all thrown as {@link DbError}):
 * - `$cas` is not a plain object → `"$cas operator: ..."`
 * - `$cas` map is empty
 * - `$cas` value is non-numeric / non-integer
 * - `$cas` has more than one entry (v1 single-column constraint)
 * - `$cas` key does not match `versionColumn` (when provided)
 * - `$cas` is present on a non-versioned table (`versionColumn === undefined`)
 *
 * Zero-allocation on the no-op (no `$cas`) path.
 */
export function separateCas(
  data: Record<string, unknown>,
  versionColumn?: string,
): number | undefined {
  if (!("$cas" in data)) return undefined;

  // Strict: $cas on a non-versioned table is a programmer error — the caller
  // thinks they have OCC but the table has no version column. Surface loudly
  // (Rule 12) at the single source of truth instead of duplicating the guard
  // in every write-path caller.
  if (versionColumn === undefined) {
    throw new DbError("INVALID_QUERY", [
      {
        path: "$cas",
        message: "$cas operator: table has no @db.column.version; cannot use $cas",
      },
    ]);
  }

  const raw = data.$cas;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DbError("INVALID_QUERY", [
      { path: "$cas", message: "$cas operator: must be a plain object" },
    ]);
  }

  const map = raw as Record<string, unknown>;
  let foundKey: string | undefined;
  for (const k in map) {
    if (foundKey !== undefined) {
      throw new DbError("INVALID_QUERY", [
        {
          path: "$cas",
          message: "$cas operator: expected exactly one entry (v1 single-column CAS)",
        },
      ]);
    }
    foundKey = k;
  }

  if (foundKey === undefined) {
    throw new DbError("INVALID_QUERY", [
      { path: "$cas", message: "$cas operator: must contain a single version entry" },
    ]);
  }

  if (versionColumn !== undefined && foundKey !== versionColumn) {
    throw new DbError("INVALID_QUERY", [
      {
        path: `$cas.${foundKey}`,
        message: `$cas operator: key "${foundKey}" does not match version column "${versionColumn}"`,
      },
    ]);
  }

  const foundValue = map[foundKey];
  if (typeof foundValue !== "number" || !Number.isInteger(foundValue)) {
    throw new DbError("INVALID_QUERY", [
      {
        path: `$cas.${foundKey}`,
        message: `$cas operator: value for "${foundKey}" must be an integer`,
      },
    ]);
  }

  delete data.$cas;
  return foundValue;
}
