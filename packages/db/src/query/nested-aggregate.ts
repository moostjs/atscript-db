import {
  NESTED_STAGE_CONTROLS,
  isAggregateExpr,
  resolveAlias,
  resolveNested,
  type AggregateQuery,
  type NestedResolution,
  type QueryIssue,
} from "@uniqu/core";

import { DbError, invalidQuery } from "../db-error";
import type { TDbFieldMeta } from "../types";
import type { TableMetadata } from "../table/table-metadata";
import { SOURCE_VALUE_FNS, SUPPORTED_AGGREGATE_FNS } from "./aggregate-fns";
import {
  isBucketableField,
  isJsonValueField,
  tableNamePredicate,
  type TBucketFieldSource,
} from "./buckets";

/**
 * The controls an aggregate query takes (since 0.1.168). Any other `$`-key is
 * rejected (`INVALID_QUERY`): an aggregate that ignored a control it does not
 * know would answer a different question than the one asked. `$with` is
 * accepted only empty.
 */
export const AGGREGATE_CONTROLS: ReadonlySet<string> = new Set([
  "$groupBy",
  "$select",
  "$having",
  "$sort",
  "$nulls",
  "$rowOrder",
  "$skip",
  "$limit",
  "$count",
  "$search",
  "$index",
  "$from",
  "$with",
]);

/**
 * Rejects (`INVALID_QUERY`, `path` = the control) an aggregate control that is
 * not one of {@link AGGREGATE_CONTROLS}, and a non-empty `$with` (relations do
 * not load on grouped rows). `undefined` values are ignored.
 *
 * @since 0.1.168
 */
export function checkAggregateControls(controls: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(controls)) {
    if (value === undefined) continue;
    if (!AGGREGATE_CONTROLS.has(key)) {
      throw invalidQuery(key, `Unknown aggregate control "${key}"`);
    }
    if (key === "$with" && !(Array.isArray(value) && value.length === 0)) {
      throw invalidQuery("$with", "$with is not valid in an aggregate query");
    }
  }
}

/** A failed {@link resolveNested} as `INVALID_QUERY` (every issue, with its `AGG_NESTED_*` code). */
function nestedIssues(issues: readonly QueryIssue[]): DbError {
  return new DbError(
    "INVALID_QUERY",
    issues.map(({ path, message, code }) => (code ? { path, message, code } : { path, message })),
  );
}

/**
 * uniqu's `resolveNested` with this table's names, throwing its issues as
 * `INVALID_QUERY`. Without `isNumericField` it answers the shape only — run
 * it so before the inner level's capability gate, and with `isNumericField`
 * (which must answer `undefined` for a field the request may not see) after.
 *
 * @since 0.1.168
 */
export function resolveNestedOrThrow(
  controls: Record<string, unknown>,
  fields: TBucketFieldSource,
  isNumericField?: (field: string) => boolean | undefined,
): Extract<NestedResolution, { ok: true }> {
  const res = resolveNested(controls, {
    isField: tableNamePredicate(fields),
    fns: SUPPORTED_AGGREGATE_FNS,
    isNumericField,
  });
  if (!res.ok) throw nestedIssues(res.issues);
  return res;
}

/**
 * Whether a field's inner column holds numbers for the outer level of a
 * two-level aggregate (`sum` / `avg`, arithmetic, a calendar bucket): a
 * `number` / `integer` leaf with scalar storage — timestamps included (an
 * outer bucket reads them). A decimal is no number here (its values are
 * exact strings), nor is an encrypted field.
 *
 * @since 0.1.168
 */
export function holdsNumbers(fd: TDbFieldMeta): boolean {
  if (fd.encrypted || isJsonValueField(fd)) return false;
  return fd.designType === "number" || fd.designType === "integer";
}

/** `isNumericField` of the core ({@link holdsNumbers} by path; `undefined` for an unknown path). */
export function metaIsNumericField(meta: TableMetadata): (field: string) => boolean | undefined {
  return (field) => {
    const fd = meta.descriptorByPath.get(field);
    return fd ? holdsNumbers(fd) : undefined;
  };
}

/**
 * The inner level of a two-level aggregate as a standalone grouped query —
 * the stage's own controls ({@link NESTED_STAGE_CONTROLS}), the query filter
 * and the root `$search` / `$index`, which narrow the rows it groups.
 *
 * @since 0.1.168
 */
export function innerAggregateQuery(query: AggregateQuery): AggregateQuery {
  const root = query.controls as unknown as Record<string, unknown>;
  const stage = root.$from as Record<string, unknown>;
  const controls: Record<string, unknown> = {};
  for (const key of NESTED_STAGE_CONTROLS) {
    if (stage[key] !== undefined) controls[key] = stage[key];
  }
  if (root.$search !== undefined) controls.$search = root.$search;
  if (root.$index !== undefined) controls.$index = root.$index;
  return { filter: query.filter, controls } as unknown as AggregateQuery;
}

/**
 * What an inner column holds, for the outer level's schema rules: a plain
 * `$groupBy` key reads its field; a `min` / `max` / `first` / `last` its
 * source field's value. Other columns (counts, sums, expressions, bucket
 * labels) have no field.
 */
export interface TInnerColumnSource {
  /** `key` — a plain inner `$groupBy` field; `computed` — an inner alias (buckets included). */
  kind: "key" | "computed";
  /** The field whose values the column holds, when it holds one field's values. */
  fd?: TDbFieldMeta;
}

/**
 * Every inner column of a two-level aggregate by name: the plain `$groupBy`
 * keys, then the computed `$select` aliases (bucket labels included).
 *
 * @since 0.1.168
 */
export function innerColumnSources(
  stage: Record<string, unknown>,
  meta: TableMetadata,
): Map<string, TInnerColumnSource> {
  const out = new Map<string, TInnerColumnSource>();
  const select = Array.isArray(stage.$select) ? (stage.$select as unknown[]) : [];
  const computed = new Map<string, TInnerColumnSource>();
  for (const item of select) {
    if (item === null || typeof item !== "object") continue;
    const alias = resolveAlias(item as never) as unknown;
    if (typeof alias !== "string" || !alias) continue;
    const fd =
      isAggregateExpr(item) && SOURCE_VALUE_FNS.has(item.$fn) && typeof item.$field === "string"
        ? meta.descriptorByPath.get(item.$field)
        : undefined;
    computed.set(alias, fd ? { kind: "computed", fd } : { kind: "computed" });
  }
  for (const key of Array.isArray(stage.$groupBy) ? (stage.$groupBy as unknown[]) : []) {
    if (typeof key !== "string" || computed.has(key) || out.has(key)) continue;
    const fd = meta.descriptorByPath.get(key);
    out.set(key, fd ? { kind: "key", fd } : { kind: "key" });
  }
  for (const [name, source] of computed) out.set(name, source);
  return out;
}

/**
 * Rejects (`INVALID_QUERY`) an outer calendar bucket whose source is not an
 * inner column holding timestamps — a timestamp `$groupBy` key, or the `min`
 * / `max` / `first` / `last` of a timestamp field. The outer level is not
 * subject to strict (dimension / measure) mode.
 *
 * @since 0.1.168
 */
export function checkOuterBucketSources(
  resolution: Extract<NestedResolution, { ok: true }>,
  columns: ReadonlyMap<string, TInnerColumnSource>,
): void {
  for (const bucket of resolution.outer.buckets) {
    const fd = columns.get(bucket.field)?.fd;
    if (!fd || !isBucketableField(fd)) {
      throw invalidQuery(
        "$select",
        `Cannot bucket "${bucket.field}" — not a timestamp column of $from (a timestamp $groupBy key, or the min / max / first / last of a timestamp field)`,
      );
    }
  }
}
