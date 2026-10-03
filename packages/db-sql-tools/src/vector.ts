import type { UniquSelect } from "@atscript/db";

import type { SqlDialect, TSqlFragment } from "./dialect";
import { finalizeParams } from "./dialect";
import { SEARCH_SOURCE_ALIAS } from "./geo";
import { buildProjection } from "./sql-builder";

/** Column every vector search row carries: the engine's distance to the query vector. */
export const VECTOR_DISTANCE_ALIAS = "_distance";

/** Alias of the row source inside the vector search queries. */
const SOURCE_ALIAS = "_v";

/**
 * The row source of a vector search over a plain table:
 *
 * ```sql
 * SELECT t.*, <distExpr> AS _distance FROM <table> t WHERE <where>
 * ```
 *
 * `withRows: false` selects the distance only (the count companion).
 * Placeholders stay `?`-style.
 * @since 0.1.143
 */
export function vectorDistanceSource(
  dialect: SqlDialect,
  table: string,
  where: TSqlFragment,
  distExpr: TSqlFragment,
  withRows = true,
): TSqlFragment {
  const t = dialect.quoteTable(SEARCH_SOURCE_ALIAS);
  const rows = withRows ? `${t}.*, ` : "";
  return {
    sql: `SELECT ${rows}${distExpr.sql} AS ${dialect.quoteIdentifier(VECTOR_DISTANCE_ALIAS)} FROM ${dialect.quoteTable(table)} AS ${t} WHERE ${where.sql}`,
    params: [...distExpr.params, ...where.params],
  };
}

/** The outer WHERE of a vector search: the distance cap, then a residual filter over the source. */
function outerWhere(
  dialect: SqlDialect,
  maxDistance: number | undefined,
  residual: TSqlFragment | undefined,
): TSqlFragment {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (maxDistance !== undefined) {
    parts.push(`${dialect.quoteIdentifier(VECTOR_DISTANCE_ALIAS)} <= ?`);
    params.push(maxDistance);
  }
  if (residual && residual.sql !== "1=1") {
    parts.push(`(${residual.sql})`);
    params.push(...residual.params);
  }
  return { sql: parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "", params };
}

/**
 * Builds a distance-ranked vector search SELECT over a row source that
 * carries a `_distance` column ({@link vectorDistanceSource}, or an
 * engine-specific one such as a vector-index join):
 *
 * ```sql
 * SELECT <_v.cols, _v._distance | *> FROM (<source>) _v
 * [WHERE _distance <= ? [AND (<residual>)]]
 * ORDER BY _distance ASC LIMIT ? [OFFSET ?]
 * ```
 *
 * `$select` projects the OUTER query exactly like `buildSelect` does
 * (inclusion and exclusion forms, resolved by `UniquSelect.asArray`), so a
 * residual filter still sees every source column; `_distance` is always
 * returned. `maxDistance` is the threshold on the engine's distance scale;
 * a `residual` filter references the source's columns qualified by `_v`.
 * Placeholders are finalized for the dialect.
 * @since 0.1.143
 */
export function buildVectorSearchSelect(
  dialect: SqlDialect,
  source: TSqlFragment,
  opts: {
    select?: UniquSelect;
    limit: number;
    skip?: number;
    maxDistance?: number;
    residual?: TSqlFragment;
  },
): TSqlFragment {
  const v = dialect.quoteTable(SOURCE_ALIAS);
  const cols = opts.select?.asArray?.length
    ? `${buildProjection(dialect, opts.select, SOURCE_ALIAS)}, ${v}.${dialect.quoteIdentifier(VECTOR_DISTANCE_ALIAS)}`
    : "*";
  const where = outerWhere(dialect, opts.maxDistance, opts.residual);
  let sql = `SELECT ${cols} FROM (${source.sql}) AS ${v}${where.sql} ORDER BY ${dialect.quoteIdentifier(VECTOR_DISTANCE_ALIAS)} ASC LIMIT ?`;
  const params: unknown[] = [...source.params, ...where.params, opts.limit];
  if (opts.skip) {
    sql += ` OFFSET ?`;
    params.push(opts.skip);
  }
  return finalizeParams(dialect, { sql, params });
}

/**
 * Count companion for {@link buildVectorSearchSelect} — rows the search
 * could return (distance cap and residual applied, pagination ignored).
 * Returns one row: `{ cnt }`.
 * @since 0.1.143
 */
export function buildVectorSearchCount(
  dialect: SqlDialect,
  source: TSqlFragment,
  opts: { maxDistance?: number; residual?: TSqlFragment },
): TSqlFragment {
  const where = outerWhere(dialect, opts.maxDistance, opts.residual);
  return finalizeParams(dialect, {
    sql: `SELECT COUNT(*) AS cnt FROM (${source.sql}) AS ${dialect.quoteTable(SOURCE_ALIAS)}${where.sql}`,
    params: [...source.params, ...where.params],
  });
}
