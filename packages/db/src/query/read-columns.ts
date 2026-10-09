import type { DbQuery } from "../types";
import { isResolvedRelationFilter } from "./relation-filter";

/**
 * What a read renders: rows (`findOne` / `findMany` / per-partition pages),
 * a row count, or an aggregate (`aggregate`, with or without `$count`).
 * @since 0.1.153
 */
export type TReadColumnsKind = "rows" | "count" | "aggregate";

/** Logical connectives whose operands are sub-filters. */
const CONNECTIVES = new Set(["$and", "$or", "$nor"]);

/**
 * Adds every PHYSICAL column a translated filter reads to `out`: comparison
 * keys, and — for a resolved relational predicate (`$some` / `$none`) — the
 * source-side columns it correlates on. Returns `false` when the filter holds
 * a top-level operator this walker does not know (then every column must be
 * assumed read).
 */
function collectFilter(filter: unknown, out: Set<string>): boolean {
  if (!filter || typeof filter !== "object") return true;
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (CONNECTIVES.has(key)) {
      if (!Array.isArray(value)) return false;
      for (const child of value) {
        if (!collectFilter(child, out)) return false;
      }
      continue;
    }
    if (key === "$not") {
      if (!collectFilter(value, out)) return false;
      continue;
    }
    if (key.startsWith("$")) return false;
    out.add(key);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const operand of Object.values(value as Record<string, unknown>)) {
        if (isResolvedRelationFilter(operand)) {
          for (const pair of operand.pairs) out.add(pair.source);
          for (const pair of operand.junction?.toSource ?? []) out.add(pair.source);
        } else if (operand && typeof operand === "object" && "$field" in operand) {
          // A field-to-field comparison operand (`{ $field: "other" }`)
          const other = (operand as { $field: unknown }).$field;
          if (typeof other !== "string") return false;
          out.add(other);
        }
      }
    }
  }
  return true;
}

/**
 * The PHYSICAL columns of the queried table (or view) that a read of `kind`
 * renders — filter keys and relational-predicate correlation columns, sort
 * keys, `partitionBy`, the projection, and for an aggregate the group keys,
 * bucket / aggregate / expression / `first`-`last` sources and `$having`
 * keys. Names that are not columns (aggregate aliases) may be included — a
 * consumer ignores names it does not know.
 *
 * `undefined` means EVERY column: the read projects all columns (no
 * `$select`, so `SELECT *`), or its filter holds an operator this collector
 * does not recognise. A view read may drop a left join only when no returned
 * column reads it, so over-inclusion is always safe.
 * @since 0.1.153
 */
export function queryReadColumns(
  query: DbQuery,
  kind: TReadColumnsKind,
  partitionBy?: readonly string[],
): Set<string> | undefined {
  const out = new Set<string>();
  if (!collectFilter(query.filter, out)) return undefined;
  if (kind === "count") return out;

  const controls = query.controls ?? {};
  // `$sort` arrives with the primary-key tie-breaker appended and `$nulls`
  // resolved (`@db.sort.nulls` defaults included): both name sort keys.
  for (const key of Object.keys(controls.$sort ?? {})) out.add(key);
  for (const key of Object.keys(controls.$nulls ?? {})) out.add(key);
  for (const column of partitionBy ?? []) out.add(column);
  const select = controls.$select;
  const fields = select?.asArray;

  if (kind === "rows") {
    // `buildProjection` / a document projection read every column without a field list
    if (!fields || fields.length === 0) return undefined;
    for (const field of fields) out.add(field);
    return out;
  }

  const groupBy = (controls.$groupBy as string[] | undefined) ?? [];
  const computed = select?.computedAliases.length ?? 0;
  if (!fields?.length && !select?.buckets?.length && computed === 0) {
    // Nothing selected — the aggregate renders `SELECT *`
    return undefined;
  }
  for (const field of fields ?? []) out.add(field);
  for (const key of groupBy) out.add(key);
  for (const bucket of select?.buckets ?? []) out.add(bucket.field);
  for (const expr of select?.aggregates ?? []) {
    if (expr.$field !== "*") out.add(expr.$field);
  }
  for (const e of select?.exprAggregates ?? []) {
    for (const name of e.names) out.add(name);
  }
  for (const e of select?.exprs ?? []) {
    for (const name of e.names) out.add(name);
  }
  for (const fl of select?.firstLast ?? []) out.add(fl.column);
  for (const key of select?.rowOrder ?? []) out.add(key.column);
  for (const column of select?.sources.keys() ?? []) out.add(column);
  if (controls.$having && !collectFilter(controls.$having, out)) return undefined;
  return out;
}
