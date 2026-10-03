import type { TResolvedBucket, TViewJsonType } from "@atscript/db";

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
   * HAVING references a calendar bucket — and a view's JSON-extracted
   * dimension ({@link jsonExtract}) — by its quoted SELECT alias instead of
   * re-rendering the expression (the aggregate count query's inner SELECT
   * lists `<bucket expr> AS alias`, so the alias exists there too).
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
  /**
   * Typed extraction of one primitive leaf inside a JSON column — how a view
   * field that references a descendant of a `@db.json` column reads it.
   *
   * Semantics (identical on every dialect): the result is the declared
   * primitive, or NULL when the path is missing, the value is JSON `null`, or
   * the value has another JSON type — never a coercion (the JSON string
   * `"5"` is NULL for a `number` leaf). Numbers come back as doubles (integers
   * beyond 2^53 lose precision); booleans as the dialect's boolean
   * representation (0/1 where booleans are integers).
   *
   * `quotedCol` is already quoted (`"table"."column"`); `path` holds the
   * segments below it. The expression must be PARAMETER-FREE — it renders in
   * CREATE VIEW DDL, repeated in SELECT, GROUP BY, HAVING and aggregate
   * arguments. Quote every segment via {@link quotedJsonPathSegments}.
   * Dialects without JSON extraction omit this; view sync then fails with
   * `JSON extraction is not supported by this adapter`.
   *
   * @since 0.1.136
   */
  jsonExtract?(quotedCol: string, path: readonly string[], type: TViewJsonType): string;
  /**
   * `expr` cast to an IEEE double — how a computed view column
   * (`@db.compute`) evaluates every field / literal leaf, so `7 / 2 = 3.5`
   * everywhere (no integer division, no DECIMAL rounding): SQLite
   * `CAST(x AS REAL)`, MySQL `CAST(x AS DOUBLE)`, PostgreSQL
   * `CAST(x AS DOUBLE PRECISION)`. Parameter-free. Dialects without it fail
   * view sync with `computed view columns are not supported by this adapter`.
   * @since 0.1.147
   */
  castDouble?(expr: string): string;
  /**
   * `true` when the database sorts NULL as the LARGEST value (PostgreSQL):
   * first-row join order keys then render `ASC NULLS FIRST` /
   * `DESC NULLS LAST`, keeping the uniform "NULL is the smallest value"
   * ordering SQLite, MySQL and MongoDB have natively.
   * @since 0.1.147
   */
  nullsSortLargest?: boolean;
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

/**
 * How HAVING references a grouped NON-column expression (a calendar bucket, a
 * view's JSON-extracted dimension): its quoted SELECT `alias` on dialects that
 * set {@link SqlDialect.bucketAliasInHaving}, else the expression itself.
 */
export function havingGroupRef(dialect: SqlDialect, expr: string, alias: string): string {
  return dialect.bucketAliasInHaving ? dialect.quoteIdentifier(alias) : expr;
}

/**
 * Each JSON path segment wrapped in double quotes (`"a"`), for the dialects'
 * {@link SqlDialect.jsonExtract} path literals (`'$."a"."b"'`, `'{"a","b"}'`).
 *
 * A segment containing `"`, `\` or a control character has no quoting that
 * reads the same on every dialect (SQLite's quoted path labels have no escape
 * syntax), so it is rejected rather than escaped.
 *
 * @since 0.1.136
 * @throws for an empty path or a segment that is empty or holds such a character.
 */
export function quotedJsonPathSegments(path: readonly string[]): string[] {
  if (path.length === 0) {
    throw new Error("JSON extraction needs a path below the JSON column");
  }
  return path.map((seg) => {
    let ok = seg.length > 0;
    for (let i = 0; ok && i < seg.length; i++) {
      const code = seg.charCodeAt(i);
      ok = code >= 0x20 && code !== 0x22 && code !== 0x5c;
    }
    if (!ok) {
      throw new Error(
        `JSON path segment ${JSON.stringify(seg)} can't be extracted — segments must be non-empty and free of '"', '\\' and control characters`,
      );
    }
    return `"${seg}"`;
  });
}

export const EMPTY_AND: TSqlFragment = { sql: "1=1", params: [] };
export const EMPTY_OR: TSqlFragment = { sql: "0=1", params: [] };
