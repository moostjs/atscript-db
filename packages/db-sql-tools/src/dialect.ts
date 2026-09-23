import type { TResolvedBucket } from "@atscript/db";

export interface TSqlFragment {
  sql: string;
  params: unknown[];
}

/** `$geoWithin` circle: `[lng, lat]` center + radius in meters (core-validated). */
export interface TGeoCircle {
  center: [number, number];
  radius: number;
}

export interface SqlDialect {
  /** Quotes a column/table name */
  quoteIdentifier(name: string): string;
  /** Quotes a possibly schema-qualified table name */
  quoteTable(name: string): string;
  /** SQL literal for unlimited LIMIT (SQLite: '-1', MySQL: '18446744073709551615') */
  unlimitedLimit: string;
  /** Convert JS value to SQL-bindable param for DML */
  toValue(value: unknown): unknown;
  /** Convert JS value to SQL-bindable param for filters (lighter) */
  toParam(value: unknown): unknown;
  /** Handle $regex filter */
  regex(quotedCol: string, value: unknown): TSqlFragment;
  /**
   * Handle `$geoWithin` filter — circle search on a `db.geoPoint` column.
   * The circle is pre-validated by the core layer (`center` is a `[lng, lat]`
   * tuple, `radius` a positive number of meters). Dialects without native geo
   * support omit this; the filter visitor then throws `GEO_NOT_SUPPORTED`.
   */
  geoWithin?(quotedCol: string, circle: TGeoCircle): TSqlFragment;
  /**
   * Calendar-bucket label expression over one column: TEXT `'YYYY-MM-DD'`
   * (the local calendar date of the bucket's first day in `b.tz`), or NULL for
   * a NULL source or one outside `[BUCKET_MIN_INSTANT, BUCKET_MAX_INSTANT)`.
   * `quotedCol` is already quoted; `b.fd` identifies the storage kind.
   *
   * The expression must be PARAMETER-FREE — inline the zone with
   * `sqlTimeZoneLiteral(b.tz)` and the unit / week start as literals (the
   * shared builders assert them against their closed sets first) — because
   * the builders render it in SELECT, GROUP BY and HAVING and PostgreSQL
   * matches GROUP BY expressions structurally (and the bind-parameter order
   * must not change). Dialects without calendar buckets omit this; the
   * builders then throw `BUCKET_NOT_SUPPORTED`. Since 0.1.132.
   */
  calendarBucket?(quotedCol: string, b: TResolvedBucket): string;
  /**
   * HAVING references a calendar bucket by its quoted SELECT alias instead of
   * re-rendering the bucket expression (the aggregate count query's inner
   * SELECT lists `<bucket expr> AS alias`, so the alias exists there too).
   *
   * MySQL needs this: the bucket expression reads the raw source column, which
   * is not itself in GROUP BY (only the expression is), so HAVING rejects it
   * (`ER_BAD_FIELD_ERROR … in 'having clause'`), while MySQL does resolve
   * SELECT aliases in HAVING. PostgreSQL is the opposite (no SELECT aliases in
   * HAVING), so dialects that omit this keep the expression form. Aggregate
   * aliases are unaffected — they always render as the inlined aggregate call.
   * Since 0.1.132.
   */
  bucketAliasInHaving?: boolean;
  /** e.g. 'CREATE VIEW IF NOT EXISTS' or 'CREATE OR REPLACE VIEW' */
  createViewPrefix: string;
  /** Returns a parameter placeholder for the given 1-based index. When absent, '?' is used. */
  paramPlaceholder?: (index: number) => string;
}

/**
 * Replaces positional `?` placeholders with dialect-specific numbered placeholders
 * (e.g. `$1, $2, ...` for PostgreSQL). No-op when `dialect.paramPlaceholder` is not set.
 */
export function finalizeParams(dialect: SqlDialect, fragment: TSqlFragment): TSqlFragment {
  if (!dialect.paramPlaceholder) {
    return fragment;
  }
  let idx = 0;
  const sql = fragment.sql.replace(/\?/g, () => dialect.paramPlaceholder!(++idx));
  return { sql, params: fragment.params };
}

export const EMPTY_AND: TSqlFragment = { sql: "1=1", params: [] };
export const EMPTY_OR: TSqlFragment = { sql: "0=1", params: [] };
