import type { AggregateFn } from "@uniqu/core";

import { DbError } from "../db-error";

/** The aggregate functions atscript-db adapters implement — uniqu's set minus `countDistinct`. */
export type TDbAggregateFn = Exclude<AggregateFn, "countDistinct">;

/**
 * The only `$fn` names a `$select` aggregate may use (since 0.1.135). Any
 * other name is rejected with `INVALID_QUERY` (HTTP 400 through moost-db)
 * before a query reaches an adapter, so no adapter ever renders an unchecked
 * function name into SQL or a pipeline.
 */
export const SUPPORTED_AGGREGATE_FNS: readonly TDbAggregateFn[] = [
  "sum",
  "count",
  "avg",
  "min",
  "max",
];

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
