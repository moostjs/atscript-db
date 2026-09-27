import { assertAggregateFn } from "@atscript/db/agg";
import type { Document } from "mongodb";

import { notNullExpr } from "./mongo-view-expr";

/**
 * The `$group` accumulator of one aggregate — shared by grouped queries
 * (`agg.ts`) and managed views (`mongo-view-pipeline.ts`), so both count and
 * sum alike.
 *
 * - `count(*)` → `{ $sum: 1 }`; `count(f)` counts values that are neither
 *   null nor missing (SQL `COUNT(f)`);
 * - `sum` / `avg` / `min` / `max` → `$sum` / `$avg` / `$min` / `$max` (all
 *   skip null / missing values);
 * - `countDistinct(f)` → `{ $addToSet: { $ifNull: [f, "$$REMOVE"] } }`, a
 *   SET of the non-null values (`$$REMOVE` adds nothing) the caller turns
 *   into its size with {@link distinctCountExpr}.
 *
 * `where` (a conditional aggregate's row predicate, an aggregation
 * expression) swaps the source for `{ $cond: [where, src, null] }` — the
 * rejected rows contribute a null, which every accumulator skips — and makes
 * the counts `{ $sum: { $cond: [where (and not null), 1, 0] } }`.
 *
 * @param fn - The aggregate function (re-asserted: `INVALID_QUERY` when unknown).
 * @param src - The source operand (`"$path"`), or `"*"` for `count(*)`.
 * @param where - Row predicate of a conditional aggregate.
 * @param path - Error path of the re-assertion.
 */
export function buildAccumulator(
  fn: unknown,
  src: string,
  where?: Document,
  path?: string,
): Document {
  assertAggregateFn(fn, path);
  if (fn === "count") {
    if (src === "*") {
      return { $sum: where ? { $cond: [where, 1, 0] } : 1 };
    }
    const counted = where ? { $and: [where, notNullExpr(src)] } : notNullExpr(src);
    return { $sum: { $cond: [counted, 1, 0] } };
  }
  const value = where ? { $cond: [where, src, null] } : src;
  return fn === "countDistinct"
    ? { $addToSet: { $ifNull: [value, "$$REMOVE"] } }
    : { [`$${fn}`]: value };
}

/**
 * The size of a `countDistinct` set (`"$alias"`) — the value the accumulator
 * stands for, projected right after `$group` so later stages (`$having`,
 * `$sort`) see a number.
 */
export function distinctCountExpr(set: string): Document {
  return { $size: set };
}
