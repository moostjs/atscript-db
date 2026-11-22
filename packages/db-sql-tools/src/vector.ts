import type { UniquSelect } from "@atscript/db";

import type { SqlDialect, TSqlFragment } from "./dialect";
import { finalizeParams } from "./dialect";
import { GEO_DISTANCE_ALIAS, SEARCH_SOURCE_ALIAS } from "./geo";
import { buildProjection } from "./sql-builder";

/**
 * Internal alias for the engine's distance column in vector search queries,
 * the same as geo's: {@link addVectorScore} turns it into the public `$score`.
 */
export const VECTOR_DISTANCE_ALIAS = GEO_DISTANCE_ALIAS;

/**
 * A similarity metric with a `$score` scale, by its distance (lower = closer):
 * `cosine` `1 − cos` (0 to 2), `euclidean` the straight-line distance,
 * `dotProduct` the NEGATIVE inner product (pgvector's `<#>`).
 * @since 0.1.183
 */
export type TVectorMetric = "cosine" | "euclidean" | "dotProduct";

/**
 * The `$score` of a row at `distance` on `metric`: higher = closer, on the
 * MongoDB Atlas `vectorSearchScore` scale (`dotProduct` leaves 0–1 for
 * vectors that are not normalized).
 * @since 0.1.183
 */
export function vectorScoreFromDistance(metric: TVectorMetric, distance: number): number {
  switch (metric) {
    case "euclidean": {
      return 1 / (1 + distance);
    }
    case "dotProduct": {
      return (1 - distance) / 2;
    }
    default: {
      return 1 - distance / 2;
    }
  }
}

/**
 * The largest distance whose {@link vectorScoreFromDistance} reaches
 * `threshold` — a row is kept iff its distance is at most this. `undefined`
 * = no cap (a `euclidean` threshold at or below `0`).
 * @since 0.1.183
 */
export function vectorMaxDistance(metric: TVectorMetric, threshold: number): number | undefined {
  switch (metric) {
    case "euclidean": {
      return threshold > 0 ? 1 / threshold - 1 : undefined;
    }
    case "dotProduct": {
      return 1 - 2 * threshold;
    }
    default: {
      return 2 * (1 - threshold);
    }
  }
}

/**
 * Replaces a vector search row's {@link VECTOR_DISTANCE_ALIAS} column with
 * `$score` (in place). Every row has a distance: a row source never yields
 * one without ({@link vectorDistanceSource}).
 * @since 0.1.183
 */
export function addVectorScore(
  row: Record<string, unknown>,
  metric: TVectorMetric,
): Record<string, unknown> {
  row.$score = vectorScoreFromDistance(metric, Number(row[VECTOR_DISTANCE_ALIAS]));
  delete row[VECTOR_DISTANCE_ALIAS];
  return row;
}

/** Alias of the row source inside the vector search queries. */
const SOURCE_ALIAS = "_v";

/**
 * The row source of a vector search over a plain table — the rows that have
 * a distance (a row without a stored vector has none; since 0.1.183 it is
 * never returned nor counted):
 *
 * ```sql
 * SELECT * FROM (SELECT t.*, <distExpr> AS __atscript_distance FROM <table> t WHERE <where>) _d
 * WHERE __atscript_distance IS NOT NULL
 * ```
 *
 * `withRows: false` selects the distance only (the count companion).
 * Placeholders stay `?`-style. An engine's own vector-index source (SQLite
 * `vec0`) holds only rows with a vector.
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
  const distance = dialect.quoteIdentifier(VECTOR_DISTANCE_ALIAS);
  const inner = `SELECT ${rows}${distExpr.sql} AS ${distance} FROM ${dialect.quoteTable(table)} AS ${t} WHERE ${where.sql}`;
  return {
    sql: `SELECT * FROM (${inner}) AS ${dialect.quoteTable("_d")} WHERE ${distance} IS NOT NULL`,
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
 * carries a {@link VECTOR_DISTANCE_ALIAS} column ({@link vectorDistanceSource},
 * or an engine-specific one such as a vector-index join):
 *
 * ```sql
 * SELECT <_v.cols, _v.__atscript_distance | *> FROM (<source>) _v
 * [WHERE __atscript_distance <= ? [AND (<residual>)]]
 * ORDER BY __atscript_distance ASC LIMIT ? [OFFSET ?]
 * ```
 *
 * `$select` projects the OUTER query exactly like `buildSelect` does
 * (inclusion and exclusion forms, resolved by `UniquSelect.asArray`), so a
 * residual filter still sees every source column; the distance column is
 * always selected. `maxDistance` is the threshold on the engine's distance scale;
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
