// ── Field operation helpers ──────────────────────────────────────────────────
// Pure functions returning JSON-serializable objects.
// Safe for frontend use — zero runtime dependencies.

/** A numeric field operation (increment, decrement, or multiply). */
export interface TDbFieldOp {
  $inc?: number;
  $dec?: number;
  $mul?: number;
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
