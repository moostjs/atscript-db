import type { FilterExpr } from "@atscript/db";

import { dedupeIdentities, findRowsByIds, type TRowsByIdSource } from "./rows-by-id";

/**
 * Which surface asks {@link TDbActionScopeContext} — see
 * `AsDbReadableController.actionRowScope`:
 *
 * - `"execute"` — the action gate, about to run the action on `ids`;
 * - `"rows"` — `$actions` on a read (also a view's delegated verdicts);
 * - `"available"` — `GET /meta/actions/:id` (one row).
 *
 * @since 0.1.147
 */
export type TDbActionScopePurpose = "execute" | "rows" | "available";

/**
 * The candidate rows `AsDbReadableController.actionRowScope` is asked about
 * (since 0.1.147). Every candidate is already inside the controller's row
 * overlay; the hook's result restricts them further.
 *
 * @since 0.1.147
 */
export interface TDbActionScopeContext {
  /** Which surface asks — the action gate, `$actions` on a read, or `GET /meta/actions`. */
  readonly purpose: TDbActionScopePurpose;
  /**
   * The candidates' identities (`preferredId`-shaped), deduped and never
   * empty. ONE array object per evaluation, shared by every action of it —
   * memoize on it (`WeakMap`) when several actions derive the same filter.
   */
  readonly ids: readonly Record<string, unknown>[];
  /**
   * The candidates' `fields` (plus the identity fields), read straight from
   * the bound readable without any overlay (the candidates already passed
   * it). Memoized per evaluation and field set. Nothing of it reaches the
   * response.
   */
  loadRows(fields: readonly string[]): Promise<readonly Record<string, unknown>[]>;
}

/** Builds the {@link TDbActionScopeContext} of one evaluation over `ids` (non-empty, deduped). */
export function createScopeContext(
  purpose: TDbActionScopePurpose,
  ids: readonly Record<string, unknown>[],
  readable: TRowsByIdSource,
): TDbActionScopeContext {
  const loaded = new Map<string, Promise<readonly Record<string, unknown>[]>>();
  return {
    purpose,
    ids,
    loadRows(fields) {
      const sorted = [...new Set(fields)].toSorted();
      const memoKey = sorted.join("\x1f");
      let rows = loaded.get(memoKey);
      if (!rows) {
        rows = findRowsByIds(readable, ids, undefined, sorted).then((found) =>
          found.filter((row): row is Record<string, unknown> => row !== undefined),
        );
        loaded.set(memoKey, rows);
      }
      return rows;
    },
  };
}

/**
 * The deduped identities of `rows` over `idFields` and, per row, its
 * identity's index in `ids` (`-1`: the row is absent or lacks a value of
 * its identity — it is in no action scope).
 */
export function candidateIds(
  rows: readonly (Record<string, unknown> | undefined)[],
  idFields: readonly string[],
): { ids: Record<string, unknown>[]; index: number[] } {
  return dedupeIdentities(rows, idFields);
}

const IDENTITY_ONLY = Symbol("identity-only");

/**
 * A structural key of a filter — canonical JSON with sorted object keys;
 * `Date`, `RegExp`, `bigint`, `undefined` and ObjectId-like values
 * (`toHexString()`) tagged — so equal-but-distinct filter objects share one
 * scope query. Plain-object keys and tags live in separate namespaces (`=`
 * and `#` prefixes), so no plain object can collide with a tagged value.
 * `undefined` (group by object identity only) when the filter holds any
 * other class instance, a function, or a number JSON can't tell apart
 * (`NaN`, `±Infinity`, `-0`).
 */
export function filterKey(filter: FilterExpr): string | undefined {
  try {
    return JSON.stringify(canonical(filter));
  } catch (error) {
    if (error === IDENTITY_ONLY) return undefined;
    throw error;
  }
}

function canonical(value: unknown): unknown {
  if (value === undefined) return { "#undefined": 1 };
  if (typeof value === "bigint") return { "#bigint": String(value) };
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    throw IDENTITY_ONLY;
  }
  if (typeof value === "function" || typeof value === "symbol") throw IDENTITY_ONLY;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return { "#date": value.toISOString() };
  if (value instanceof RegExp) return { "#regexp": [value.source, value.flags] };
  const hex = (value as { toHexString?: unknown }).toHexString;
  if (typeof hex === "function") return { "#oid": hex.call(value) };
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw IDENTITY_ONLY;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value).toSorted()) {
    out[`=${k}`] = canonical((value as Record<string, unknown>)[k]);
  }
  return out;
}
