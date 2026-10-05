import { ROW_ORDER_FNS, isAggregateExpr, type AggregateExpr, type AggregateFn } from "@uniqu/core";

import { DbError } from "../db-error";

/**
 * The aggregate functions atscript-db knows — uniqu's full `AggregateFn` set.
 * Which of them an adapter renders is its `aggregateFns()` capability.
 */
export type TDbAggregateFn = AggregateFn;

/**
 * The only `$fn` names a `$select` aggregate may use. Any other name is rejected with
 * `INVALID_QUERY` (HTTP 400 through moost-db) before a query reaches an
 * adapter, so no adapter ever renders an unchecked function name into SQL or
 * a pipeline. A known name missing from the adapter's `aggregateFns()` is
 * `AGG_FN_NOT_SUPPORTED`.
 */
export const SUPPORTED_AGGREGATE_FNS: readonly TDbAggregateFn[] = [
  "sum",
  "count",
  "avg",
  "min",
  "max",
  "countDistinct",
  "first",
  "last",
];

/** Whether a `$select` entry is a `first` / `last` aggregate (uniqu's `ROW_ORDER_FNS`). */
export function isFirstLast(item: unknown): item is AggregateExpr & { $fn: "first" | "last" } {
  return isAggregateExpr(item) && (ROW_ORDER_FNS as readonly string[]).includes(item.$fn);
}

/**
 * The functions that return a value OF their source field (`min` / `max` /
 * `first` / `last`), rather than a count or a number — their result takes the
 * field's type.
 */
export const SOURCE_VALUE_FNS: ReadonlySet<string> = new Set(["min", "max", "first", "last"]);

/**
 * The aggregates that are NULL over no (non-null) value — every function but
 * the counts, which are 0. So a view field reading a left-joined table must be
 * optional unless it counts, and a CONDITIONAL one must be optional when no
 * row may match — except `sum`, whose conditional form is rendered as
 * `COALESCE(…, 0)`.
 */
export const NULL_WHEN_EMPTY_AGGREGATE_FNS: ReadonlySet<TDbAggregateFn> = new Set<TDbAggregateFn>([
  "sum",
  "avg",
  "min",
  "max",
  "first",
  "last",
]);

/**
 * The `@db.agg.*` annotation names, one per aggregate function a managed view
 * declares — every query-time function but `first` / `last` (a representative
 * row needs a query's `$rowOrder`).
 */
export const AGG_ANNOTATIONS = SUPPORTED_AGGREGATE_FNS.filter(
  (fn) => !ROW_ORDER_FNS.includes(fn),
).map((fn) => `db.agg.${fn}` as const);

/**
 * `BaseDbAdapter.aggregateFns()` by default: every function except
 * `countDistinct`, `first` and `last`.
 */
export const BASE_AGGREGATE_FNS: ReadonlySet<TDbAggregateFn> = new Set<TDbAggregateFn>([
  "sum",
  "count",
  "avg",
  "min",
  "max",
]);

/**
 * Every aggregate function — what an adapter that renders them all returns
 * from `aggregateFns()` (`first` / `last` since 0.1.148).
 *
 * @since 0.1.136
 */
export const ALL_AGGREGATE_FNS: ReadonlySet<TDbAggregateFn> = new Set(SUPPORTED_AGGREGATE_FNS);

const SUPPORTED_LIST = `${SUPPORTED_AGGREGATE_FNS.slice(0, -1).join(", ")} or ${SUPPORTED_AGGREGATE_FNS.at(-1)}`;

/**
 * Throws `DbError` `INVALID_QUERY` (uniqu's wording) unless `fn` is in
 * `SUPPORTED_AGGREGATE_FNS` — for adapters to re-assert before rendering.
 */
export function assertAggregateFn(fn: unknown, path = "$select"): asserts fn is TDbAggregateFn {
  if (!(SUPPORTED_AGGREGATE_FNS as readonly unknown[]).includes(fn)) {
    const message = `Unknown aggregate function "${String(fn)}" — use ${SUPPORTED_LIST}`;
    throw new DbError("INVALID_QUERY", [{ path, message }]);
  }
}
