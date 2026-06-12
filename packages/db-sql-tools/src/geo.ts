import type { SqlDialect, TSqlFragment } from "./dialect";
import { finalizeParams } from "./dialect";

/**
 * Internal alias for the computed distance column in geo search queries.
 * Renamed to the public `$distance` pseudo-field after fetch (same convention
 * as the MongoDB adapter) — SQL identifiers starting with `$` are awkward
 * across dialects, so the public name can't be used directly.
 */
export const GEO_DISTANCE_ALIAS = "__atscript_distance";

/** Distance window for geo search: `$maxDistance` / `$minDistance` in meters. */
export interface TGeoWindow {
  maxDistance?: number;
  minDistance?: number;
}

/**
 * Builds a distance-ranked geo search SELECT:
 *
 * ```sql
 * SELECT * FROM (
 *   SELECT t.*, <distExpr> AS __atscript_distance FROM <table> t WHERE <filter>
 * ) _g
 * WHERE __atscript_distance IS NOT NULL [AND <= ?] [AND >= ?]
 * ORDER BY __atscript_distance ASC LIMIT ? [OFFSET ?]
 * ```
 *
 * `distExpr` computes meters from the query point to the geo column (NULL for
 * rows without a point — those are excluded, matching MongoDB `$geoNear`).
 * Placeholders stay `?`-style; callers finalize for `$N` dialects.
 */
export function buildGeoSearchSelect(
  dialect: SqlDialect,
  table: string,
  where: TSqlFragment,
  distExpr: TSqlFragment,
  window: TGeoWindow,
  controls: { $limit?: number; $skip?: number },
): TSqlFragment {
  const alias = dialect.quoteIdentifier(GEO_DISTANCE_ALIAS);
  const inner = `SELECT ${dialect.quoteTable("t")}.*, ${distExpr.sql} AS ${alias} FROM ${dialect.quoteTable(table)} AS ${dialect.quoteTable("t")} WHERE ${where.sql}`;
  let sql = `SELECT * FROM (${inner}) AS ${dialect.quoteTable("_g")} WHERE ${alias} IS NOT NULL`;
  const params: unknown[] = [...distExpr.params, ...where.params];

  if (window.maxDistance !== undefined) {
    sql += ` AND ${alias} <= ?`;
    params.push(window.maxDistance);
  }
  if (window.minDistance !== undefined) {
    sql += ` AND ${alias} >= ?`;
    params.push(window.minDistance);
  }

  sql += ` ORDER BY ${alias} ASC`;
  if (controls.$limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(controls.$limit);
  }
  if (controls.$skip !== undefined) {
    if (controls.$limit === undefined) {
      sql += ` LIMIT ${dialect.unlimitedLimit}`;
    }
    sql += ` OFFSET ?`;
    params.push(controls.$skip);
  }

  return finalizeParams(dialect, { sql, params });
}

/**
 * Count companion for {@link buildGeoSearchSelect} — rows inside the distance
 * window (filter applied, pagination ignored). Returns one row: `{ cnt }`.
 */
export function buildGeoSearchCount(
  dialect: SqlDialect,
  table: string,
  where: TSqlFragment,
  distExpr: TSqlFragment,
  window: TGeoWindow,
): TSqlFragment {
  const alias = dialect.quoteIdentifier(GEO_DISTANCE_ALIAS);
  const inner = `SELECT ${distExpr.sql} AS ${alias} FROM ${dialect.quoteTable(table)} AS ${dialect.quoteTable("t")} WHERE ${where.sql}`;
  let sql = `SELECT COUNT(*) AS cnt FROM (${inner}) AS ${dialect.quoteTable("_g")} WHERE ${alias} IS NOT NULL`;
  const params: unknown[] = [...distExpr.params, ...where.params];

  if (window.maxDistance !== undefined) {
    sql += ` AND ${alias} <= ?`;
    params.push(window.maxDistance);
  }
  if (window.minDistance !== undefined) {
    sql += ` AND ${alias} >= ?`;
    params.push(window.minDistance);
  }

  return finalizeParams(dialect, { sql, params });
}

/** Extracts the `$maxDistance` / `$minDistance` window from query controls. */
export function geoWindowFromControls(controls: Record<string, unknown> | undefined): TGeoWindow {
  return {
    maxDistance:
      typeof controls?.$maxDistance === "number" ? (controls.$maxDistance as number) : undefined,
    minDistance:
      typeof controls?.$minDistance === "number" ? (controls.$minDistance as number) : undefined,
  };
}

/**
 * Normalizes a write-path geo value to a `[lng, lat]` tuple. The value may be
 * the raw tuple or its JSON-string form (the relational field mapper
 * stringifies `storage: json` fields before adapter formatters run).
 * Returns `undefined` for anything else (e.g. `$geoWithin` circle objects,
 * which must pass through untouched).
 */
export function normalizeGeoPointValue(value: unknown): [number, number] | undefined {
  let candidate = value;
  if (typeof candidate === "string") {
    if (!candidate.startsWith("[")) {
      return undefined;
    }
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  if (
    Array.isArray(candidate) &&
    candidate.length === 2 &&
    typeof candidate[0] === "number" &&
    typeof candidate[1] === "number"
  ) {
    return [candidate[0], candidate[1]];
  }
  return undefined;
}

/** Renames the internal distance alias to the public `$distance` field (in place). */
export function renameGeoDistance(row: Record<string, unknown>): Record<string, unknown> {
  if (GEO_DISTANCE_ALIAS in row) {
    const distance = row[GEO_DISTANCE_ALIAS];
    delete row[GEO_DISTANCE_ALIAS];
    row.$distance = typeof distance === "string" ? Number(distance) : distance;
  }
  return row;
}
