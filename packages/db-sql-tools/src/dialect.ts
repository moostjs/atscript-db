import type { DbControls, TDbFieldMeta, TResolvedBucket, TViewJsonType } from "@atscript/db";
import type { NullsPlacement } from "@uniqu/core";

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
   * The canonical decimal text of an integer column (`29461277`, `-12` — no
   * `.0`, no exponent), as an SQL expression over the quoted column. Backs
   * `$regex` on integer fields. Defaults to `CAST(<col> AS TEXT)`.
   * @since 0.1.150
   */
  integerText?(quotedExpr: string): string;
  /**
   * Handle `$geoWithin` filter — circle search on a `db.geoPoint` column.
   * The circle is pre-validated by the core layer (`center` is a `[lng, lat]`
   * tuple, `radius` a positive number of meters). Dialects without native geo
   * support omit this; the filter visitor then throws `GEO_NOT_SUPPORTED`.
   */
  geoWithin?(quotedCol: string, circle: TGeoCircle): TSqlFragment;
  /**
   * Calendar-bucket label expression over one column: TEXT `'YYYY-MM-DD'`
   * (the local calendar date of the bucket's first day in `b.tz`; for unit
   * `hour`, `'YYYY-MM-DDTHH:00'`, the local wall-clock hour — truncate the
   * zone's wall time, never the UTC instant), or NULL for a NULL source or
   * one outside `[BUCKET_MIN_INSTANT, BUCKET_MAX_INSTANT)`.
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
   * The aggregate functions that stand in for `MIN` / `MAX` over a BOOLEAN
   * column on an engine that has no `MIN(boolean)` (PostgreSQL: `BOOL_AND` /
   * `BOOL_OR`). Absent: `MIN` / `MAX` apply to booleans as to any column.
   * @since 0.1.148
   */
  booleanAggregates?: { min: string; max: string };
  /**
   * Renders the "any value of the group" pick over an already rendered column
   * — what a `first` / `last` derived column (constant within its group)
   * aggregates through — for the column's source `field` (`undefined` when
   * unknown). The dialect picks the cheapest aggregate its engine has for the
   * column's type: a streaming `MIN` where one exists, a type-agnostic form
   * only where it does not (PostgreSQL: `MIN` for ordered types, `BOOL_AND`
   * for a boolean, `(ARRAY_AGG(x))[1]` for uuid, bytea, point, json, …).
   * Absent: `MIN(x)`.
   * @since 0.1.148
   */
  anyValue?(expr: string, field: TDbFieldMeta | undefined): string;
  /**
   * Maps a driver error of a grouped query to the `DbError` it means — a
   * numeric overflow (`arithOverflowError` when the query has arithmetic
   * expressions, else `numericOutOfRangeError`), an unknown calendar-bucket
   * zone — or `undefined` to let it propagate unchanged. `arithmetic` is
   * whether the query selects any arithmetic expression. Run by
   * {@link mapQueryErrors}.
   * @since 0.1.148
   */
  mapQueryError?(error: unknown, arithmetic: boolean): Error | undefined;
  /**
   * `true` when the database sorts NULL as the LARGEST value (PostgreSQL):
   * first-row join order keys then render `ASC NULLS FIRST` /
   * `DESC NULLS LAST`, keeping the uniform "NULL is the smallest value"
   * ordering SQLite, MySQL and MongoDB have natively.
   * @since 0.1.147
   */
  nullsSortLargest?: boolean;
  /**
   * `true` when the engine accepts `NULLS FIRST` / `NULLS LAST` on an
   * `ORDER BY` key (PostgreSQL, SQLite ≥ 3.30). Without it a requested NULL
   * placement that differs from the native one renders as an extra
   * `(<expr> IS NULL)` key ({@link nullsOrderSql}).
   * @since 0.1.153
   */
  nullsPlacementSyntax?: boolean;
  /** e.g. 'CREATE VIEW IF NOT EXISTS' or 'CREATE OR REPLACE VIEW' */
  createViewPrefix: string;
  /** Returns a parameter placeholder for the given 1-based index. When absent, '?' is used. */
  paramPlaceholder?: (index: number) => string;
}

/**
 * Replaces positional `?` placeholders with dialect-specific numbered placeholders
 * (e.g. `$1, $2, ...` for PostgreSQL). No-op when `dialect.paramPlaceholder` is not set.
 *
 * Only a `?` in plain SQL text is a placeholder: one inside a string literal
 * (`'…'`, `E'…'`, `$tag$…$tag$`), a quoted identifier (`"…"`) or a comment
 * (`-- …`, `/* … *\/`) is left alone, and so are PostgreSQL's jsonb operators
 * `?|` / `?&` (a placeholder directly followed by `|` / `&` is only ever
 * `?||` / `?&&`, the concatenation / overlap). `??` is an escaped literal
 * `?` — how a builder writes the bare jsonb `?` operator and any other
 * operator that contains `?` (`@?` → `@??`, `?#` → `??#`, `?-` → `??-`).
 * Block comments nest, as in PostgreSQL.
 */
export function finalizeParams(dialect: SqlDialect, fragment: TSqlFragment): TSqlFragment {
  const placeholder = dialect.paramPlaceholder;
  if (!placeholder) {
    return fragment;
  }
  const s = fragment.sql;
  // Fast exit: no `?` at all — nothing to number.
  if (s.indexOf("?") === -1) {
    return fragment;
  }
  let out = "";
  let last = 0;
  let idx = 0;
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === QMARK) {
      const next = s.charCodeAt(i + 1);
      if (next === QMARK) {
        // `??` → a literal `?` (escaped jsonb operator).
        out += s.slice(last, i + 1);
        last = i + 2;
        i += 2;
      } else if (
        (next === PIPE && s.charCodeAt(i + 2) !== PIPE) ||
        (next === AMP && s.charCodeAt(i + 2) !== AMP)
      ) {
        i += 2; // jsonb `?|` / `?&` operator — kept as is
      } else {
        out += s.slice(last, i) + placeholder(++idx);
        last = ++i;
      }
    } else if (c === DQUOTE) {
      i = skipQuotedIdentifier(s, i);
    } else if (c === SQUOTE) {
      i = skipStringLiteral(s, i);
    } else if (c === DASH && s.charCodeAt(i + 1) === DASH) {
      const end = s.indexOf("\n", i + 2);
      i = end === -1 ? n : end + 1;
    } else if (c === SLASH && s.charCodeAt(i + 1) === STAR) {
      i = skipBlockComment(s, i);
    } else if (c === DOLLAR) {
      i = skipDollarQuoted(s, i);
    } else {
      i++;
    }
  }
  return { sql: last === 0 ? s : out + s.slice(last), params: fragment.params };
}

const QMARK = 63; // ?
const PIPE = 124; // |
const AMP = 38; // &
const BACKSLASH = 92;
const SQUOTE = 39;
const DQUOTE = 34;
const DASH = 45;
const SLASH = 47;
const STAR = 42;
const DOLLAR = 36;

/** Index just past the `"…"` identifier opening at `at` (`""` escapes a quote). */
function skipQuotedIdentifier(s: string, at: number): number {
  let i = at + 1;
  for (;;) {
    const end = s.indexOf('"', i);
    if (end === -1) return s.length;
    if (s.charCodeAt(end + 1) !== DQUOTE) return end + 1;
    i = end + 2;
  }
}

/**
 * Index just past the `'…'` literal opening at `at` (`''` escapes a quote; in
 * a PostgreSQL `E'…'` escape string a backslash escapes the next char too).
 */
function skipStringLiteral(s: string, at: number): number {
  const prev = at > 0 ? s.charCodeAt(at - 1) : 0;
  const escapes = (prev === 69 || prev === 101) && (at < 2 || !isIdentChar(s.charCodeAt(at - 2)));
  let i = at + 1;
  for (;;) {
    const end = s.indexOf("'", i);
    if (end === -1) return s.length;
    if (escapes) {
      // Count the backslashes right before the quote: an odd run escapes it.
      let k = end - 1;
      while (k > at && s.charCodeAt(k) === BACKSLASH) k--;
      if ((end - 1 - k) % 2 === 1) {
        i = end + 1;
        continue;
      }
    }
    if (s.charCodeAt(end + 1) !== SQUOTE) return end + 1;
    i = end + 2;
  }
}

/** Index just past the `/* … *\/` comment opening at `at` (comments nest, as in PostgreSQL). */
function skipBlockComment(s: string, at: number): number {
  let depth = 1;
  let i = at + 2;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === STAR && s.charCodeAt(i + 1) === SLASH) {
      i += 2;
      if (--depth === 0) return i;
    } else if (c === SLASH && s.charCodeAt(i + 1) === STAR) {
      depth++;
      i += 2;
    } else {
      i++;
    }
  }
  return s.length;
}

/**
 * Index just past the dollar-quoted string (`$$…$$`, `$tag$…$tag$`) opening at
 * `at`, or `at + 1` when the `$` opens none (a `$1` placeholder, a `$` inside
 * an identifier).
 */
function skipDollarQuoted(s: string, at: number): number {
  if (at > 0 && isIdentChar(s.charCodeAt(at - 1))) return at + 1;
  let j = at + 1;
  const first = s.charCodeAt(j);
  if (first !== DOLLAR) {
    // A tag starts with a letter or `_` (never a digit — that is `$1`).
    if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95)) {
      return at + 1;
    }
    while (j < s.length && isIdentChar(s.charCodeAt(j)) && s.charCodeAt(j) !== DOLLAR) j++;
    if (s.charCodeAt(j) !== DOLLAR) return at + 1;
  }
  const tag = s.slice(at, j + 1);
  const end = s.indexOf(tag, j + 1);
  return end === -1 ? s.length : end + tag.length;
}

function isIdentChar(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36
  );
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
 * Runs `fn`, rethrowing a driver error as the `DbError`
 * {@link SqlDialect.mapQueryError} maps it to (any other error unchanged).
 * `controls` of the query tell whether it has arithmetic expressions.
 * @since 0.1.148
 */
export async function mapQueryErrors<R>(
  dialect: SqlDialect,
  fn: () => Promise<R>,
  controls?: DbControls,
): Promise<R> {
  try {
    return await fn();
  } catch (error: unknown) {
    const select = controls?.$select;
    const arithmetic = !!(select?.exprAggregates?.length || select?.exprs?.length);
    throw dialect.mapQueryError?.(error, arithmetic) ?? error;
  }
}

/**
 * The `$nulls` entry of one `ORDER BY` key (`controls.$nulls` is keyed like
 * `controls.$sort`), or `undefined`.
 * @since 0.1.153
 */
export function nullsPlacementOf(
  nulls: DbControls["$nulls"],
  key: string,
): NullsPlacement | undefined {
  if (!nulls) return undefined;
  const map = nulls as Record<string, NullsPlacement | undefined>;
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/**
 * One `ORDER BY` key with a requested NULL placement. Without `nulls`, the
 * plain `<expr> ASC|DESC` (the engine's native placement). With it:
 *
 * - the engine's native placement already matches (NULL is the smallest
 *   value — `ASC` → first, `DESC` → last — unless
 *   {@link SqlDialect.nullsSortLargest}, where it is the opposite) → the plain
 *   key, so an index on `expr` still serves the order;
 * - else `<expr> ASC|DESC NULLS FIRST|LAST` on a dialect with
 *   {@link SqlDialect.nullsPlacementSyntax} (or `nullsSortLargest`);
 * - else (MySQL) a leading NULL-ness key: `(<expr> IS NULL) DESC, <expr> DIR`
 *   for `first`, `(<expr> IS NULL) ASC, <expr> DIR` for `last`.
 *
 * May render two comma-separated keys — only valid inside an `ORDER BY` list.
 * `nullTest` renders the `IS NULL` operand when it must differ from `expr`
 * (MySQL resolves a name inside an expression to a table column before a
 * SELECT alias, so a grouped `ORDER BY` tests the alias's own expression).
 * @since 0.1.153
 */
export function nullsOrderSql(
  dialect: SqlDialect,
  expr: string,
  desc: boolean,
  nulls?: NullsPlacement,
  nullTest?: () => string,
): string {
  const key = `${expr} ${desc ? "DESC" : "ASC"}`;
  if (!nulls) return key;
  const nativeFirst = desc === (dialect.nullsSortLargest === true);
  if ((nulls === "first") === nativeFirst) return key;
  // `nullsSortLargest` dialects always rendered NULLS FIRST / LAST (first-row joins).
  if (dialect.nullsPlacementSyntax || dialect.nullsSortLargest) {
    return `${key} NULLS ${nulls === "first" ? "FIRST" : "LAST"}`;
  }
  return `(${nullTest ? nullTest() : expr} IS NULL) ${nulls === "first" ? "DESC" : "ASC"}, ${key}`;
}

/**
 * One `ORDER BY` key with the uniform "NULL is the smallest value" ordering
 * (`ASC` → NULL first, `DESC` → NULL last) unless `nulls` asks for another
 * placement — {@link nullsOrderSql}. Without `nulls`: `<expr> ASC` /
 * `<expr> DESC`, plus `NULLS FIRST` / `NULLS LAST` on a dialect where NULL
 * sorts largest ({@link SqlDialect.nullsSortLargest}). Shared by first-row
 * joins, `first` / `last` aggregates and the grouped `ORDER BY`.
 * @since 0.1.148 (`nulls` since 0.1.153)
 */
export function orderKeySql(
  dialect: SqlDialect,
  expr: string,
  desc: boolean,
  nulls?: NullsPlacement,
  nullTest?: () => string,
): string {
  return nullsOrderSql(dialect, expr, desc, nulls ?? (desc ? "last" : "first"), nullTest);
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

/** ORs predicate parts (parenthesized when several); no parts matches nothing. */
export function orFragment(parts: string[], params: unknown[]): TSqlFragment {
  if (parts.length === 0) return EMPTY_OR;
  return { sql: parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`, params };
}
