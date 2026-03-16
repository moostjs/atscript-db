/**
 * Aggregation runtime utilities.
 * Re-exports types and helpers that adapter implementations need
 * when implementing BaseDbAdapter.aggregate().
 */

import type { AggregateExpr } from "@uniqu/core";

export type {
  AggregateExpr,
  AggregateFn,
  AggregateControls,
  AggregateQuery,
  AggregateResult,
} from "@uniqu/core";

/** Resolves output alias: $as if provided, otherwise `{fn}_{field}`. */
export function resolveAlias(expr: AggregateExpr): string {
  return expr.$as ?? `${expr.$fn}_${expr.$field}`;
}
