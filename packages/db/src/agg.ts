/**
 * Aggregation runtime utilities.
 * Re-exports types and helpers that adapter implementations need
 * when implementing BaseDbAdapter.aggregate().
 */

export type {
  AggregateExpr,
  AggregateFn,
  AggregateControls,
  AggregateQuery,
  AggregateResult,
  BucketExpr,
  BucketUnit,
  WeekStart,
  CalendarBucketLabel,
  ComputedExpr,
  ResolvedBucket,
} from "@uniqu/core";

/**
 * Output alias of a computed `$select` entry: `$as`, else `{fn}_{field}` for an
 * aggregate or `{unit}_{field}` for a calendar bucket, with `'*'` spelled
 * `star` (`count(*)` → `count_star`). This is uniqu's rule — the one the URL
 * parser applies — re-exported so every layer names a column alike (until
 * 0.1.131 this module spelled `count(*)` as `count_*`).
 */
export { resolveAlias, isAggregateExpr, isBucketExpr } from "@uniqu/core";
export type { TResolvedBucket } from "./query/buckets";

/** The text-search request a grouped query carries, once normalised. */
interface TAggregateSearch {
  /** Non-empty, trimmed search term. */
  text: string;
  /** Named search index to target, when the caller picked one. */
  indexName?: string;
}

/**
 * Reads the `$search` / `$index` controls of an aggregate query.
 *
 * Search and grouping are orthogonal: `$search` narrows the ROWS, `$groupBy`
 * shapes what is left. Every adapter must therefore apply the search predicate
 * BEFORE grouping, so the groups — and `$count`, which counts them — only ever
 * describe rows that matched. An adapter that silently ignored the term would
 * report totals for rows the same search excludes from the leaf list.
 *
 * Two rules the leaf search path applies and the grouped path must NOT:
 * - **No implicit relevance ordering.** Relevance is a property of a row, not
 *   of a group; after `$group` there is no per-row score left to sort on.
 *   Grouped results order by `$sort` or not at all.
 * - **No implicit row cap.** The leaf runners cap an unbounded search at 1000
 *   rows; applying that before `$group` would silently truncate group counts.
 *
 * Returns `undefined` when there is nothing to search for, so callers fall
 * straight through to the plain grouped path.
 */
export function resolveAggregateSearch(
  controls: { [key: `$${string}`]: unknown } | undefined,
): TAggregateSearch | undefined {
  const raw = controls?.$search;
  if (typeof raw !== "string") {
    return undefined;
  }
  const text = raw.trim();
  if (!text) {
    return undefined;
  }
  const index = controls?.$index;
  return { text, indexName: typeof index === "string" && index ? index : undefined };
}
