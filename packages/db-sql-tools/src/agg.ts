import { type AggregateExpr, BUCKET_UNITS, WEEK_STARTS, walkFilter } from "@uniqu/core";
import { DbError, type DbControls, type TResolvedBucket } from "@atscript/db";
import { resolveAlias } from "@atscript/db/agg";

import { sqlTimeZoneLiteral } from "./common";
import type { SqlDialect, TSqlFragment } from "./dialect";
import { EMPTY_AND, finalizeParams } from "./dialect";
import { createFilterVisitor } from "./filter-builder";

export const AGG_FN_SQL: Record<string, string> = {
  sum: "SUM",
  avg: "AVG",
  count: "COUNT",
  min: "MIN",
  max: "MAX",
};

/** The bare aggregate call, e.g. `SUM("amount")` / `COUNT(*)`. */
function aggFnSql(dialect: SqlDialect, expr: AggregateExpr): string {
  const fn = AGG_FN_SQL[expr.$fn] ?? expr.$fn.toUpperCase();
  const field = expr.$field === "*" ? "*" : dialect.quoteIdentifier(expr.$field);
  return `${fn}(${field})`;
}

function buildAggExpr(dialect: SqlDialect, expr: AggregateExpr): string {
  return `${aggFnSql(dialect, expr)} AS ${dialect.quoteIdentifier(resolveAlias(expr))}`;
}

const BUCKET_UNIT_SET: ReadonlySet<string> = new Set(BUCKET_UNITS);
const WEEK_START_SET: ReadonlySet<string> = new Set(WEEK_STARTS);

/**
 * The dialect's label expression for one calendar bucket.
 *
 * Internal assertions, once for every dialect, before it renders:
 * - the dialect has `calendarBucket` — the user-facing `BUCKET_NOT_SUPPORTED`
 *   is the core's (`calendarBucketUnits()`), so only an adapter advertising
 *   units its dialect cannot render reaches this throw;
 * - the literals a dialect inlines (the expression is parameter-free) are in
 *   their closed sets — unit, week start, ISO week start 1..7 — and the zone
 *   passes `sqlTimeZoneLiteral`'s charset. Defense in depth: the core's
 *   normalizer already validated all of them.
 */
function bucketSql(dialect: SqlDialect, bucket: TResolvedBucket): string {
  if (!dialect.calendarBucket) {
    throw new DbError("BUCKET_NOT_SUPPORTED", [
      { path: "$select", message: "Calendar buckets are not supported by this adapter" },
    ]);
  }
  const { unit, weekStart, weekStartIso } = bucket;
  for (const [ok, value] of [
    [BUCKET_UNIT_SET.has(unit), unit],
    [WEEK_START_SET.has(weekStart), weekStart],
    [Number.isInteger(weekStartIso) && weekStartIso >= 1 && weekStartIso <= 7, weekStartIso],
  ] as const) {
    if (!ok) {
      throw new DbError("INVALID_QUERY", [
        { path: "$select", message: `Invalid calendar bucket argument "${String(value)}"` },
      ]);
    }
  }
  sqlTimeZoneLiteral(bucket.tz);
  return dialect.calendarBucket(dialect.quoteIdentifier(bucket.field), bucket);
}

/**
 * The SQL a `$groupBy` key renders as: a calendar-bucket alias renders the
 * bucket EXPRESSION (`dialect.calendarBucket`), anything else the quoted
 * column. GROUP BY, HAVING and the count query's GROUP BY use it — PostgreSQL
 * rejects SELECT aliases in HAVING and lets an input column of the same name
 * win in GROUP BY, so the expression form is the legal, unambiguous rendering
 * there (HAVING on MySQL is the exception — see `SqlDialect.bucketAliasInHaving`).
 * SELECT and GROUP BY render identical, parameter-free text (PostgreSQL /
 * MySQL `ONLY_FULL_GROUP_BY` match them structurally); ORDER BY keeps the
 * bare output alias.
 */
export function groupKeySql(dialect: SqlDialect, controls: DbControls, key: string): string {
  const bucket = controls.$select?.bucketByAlias(key);
  return bucket ? bucketSql(dialect, bucket) : dialect.quoteIdentifier(key);
}

/**
 * ` HAVING <predicate>` (leading space) + params for `controls.$having`, or
 * `undefined` when there is nothing to render. Shared by the row and the
 * count builders so both filter the same group set.
 *
 * A key that names an aggregate alias (`$as`, else `fn_field`) renders the
 * aggregate expression itself — `SUM("amount") > ?` — because PostgreSQL does
 * not allow a SELECT alias in HAVING (MySQL and SQLite tolerate it, so the
 * expression form keeps all three identical). A calendar-bucket alias renders
 * its bucket expression ({@link groupKeySql}), or its quoted alias when the
 * dialect sets `SqlDialect.bucketAliasInHaving` (why: see there). Other keys
 * (grouped columns) render as plain columns.
 */
function havingClause(dialect: SqlDialect, controls: DbControls): TSqlFragment | undefined {
  const having = controls.$having;
  if (!having) return undefined;
  const exprByAlias = new Map<string, string>();
  for (const expr of controls.$select?.aggregates ?? []) {
    exprByAlias.set(resolveAlias(expr), aggFnSql(dialect, expr));
  }
  const visitor = createFilterVisitor(dialect, {
    columnRef: (field) => {
      const aggExpr = exprByAlias.get(field);
      if (aggExpr) return aggExpr;
      if (dialect.bucketAliasInHaving && controls.$select?.bucketByAlias(field)) {
        return dialect.quoteIdentifier(field);
      }
      return groupKeySql(dialect, controls, field);
    },
  });
  const fragment = walkFilter(having, visitor);
  if (!fragment || fragment.sql === EMPTY_AND.sql) return undefined;
  return { sql: ` HAVING ${fragment.sql}`, params: fragment.params };
}

/** `<bucket expr> AS "alias"` for every calendar bucket in `$select`. */
function bucketSelectParts(dialect: SqlDialect, controls: DbControls): string[] {
  return (controls.$select?.buckets ?? []).map(
    (bucket) => `${bucketSql(dialect, bucket)} AS ${dialect.quoteIdentifier(bucket.alias)}`,
  );
}

/**
 * Builds a SELECT ... GROUP BY statement with aggregate functions.
 *
 * SELECT lists the plain grouped columns, then `<bucket expr> AS "alias"`
 * per calendar bucket, then the aggregates. Bucket expressions are
 * parameter-free, so the bind parameters are exactly those of the same query
 * without buckets (WHERE, HAVING, LIMIT, OFFSET).
 */
export function buildAggregateSelect(
  dialect: SqlDialect,
  table: string,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  const selectParts: string[] = [];

  // Dimension fields (plain strings from $select)
  const plainFields = controls.$select?.asArray;
  if (plainFields) {
    for (const f of plainFields) {
      selectParts.push(dialect.quoteIdentifier(f));
    }
  }

  // Calendar buckets: `<label expr> AS "alias"`
  selectParts.push(...bucketSelectParts(dialect, controls));

  // Aggregate expressions
  const aggregates = controls.$select?.aggregates;
  if (aggregates) {
    for (const expr of aggregates) {
      selectParts.push(buildAggExpr(dialect, expr));
    }
  }

  const cols = selectParts.length > 0 ? selectParts.join(", ") : "*";

  let sql = `SELECT ${cols} FROM ${dialect.quoteTable(table)} WHERE ${where.sql}`;
  const params = [...where.params];

  // GROUP BY
  const groupBy = controls.$groupBy as string[] | undefined;
  if (groupBy?.length) {
    const groupCols = groupBy.map((key) => groupKeySql(dialect, controls, key)).join(", ");
    sql += ` GROUP BY ${groupCols}`;
  }

  // HAVING
  const having = havingClause(dialect, controls);
  if (having) {
    sql += having.sql;
    params.push(...having.params);
  }

  // ORDER BY — bare names: output aliases (aggregate or bucket) are legal here on every dialect
  if (controls.$sort) {
    const orderParts: string[] = [];
    for (const [col, dir] of Object.entries(controls.$sort)) {
      orderParts.push(`${dialect.quoteIdentifier(col)} ${dir === -1 ? "DESC" : "ASC"}`);
    }
    if (orderParts.length > 0) {
      sql += ` ORDER BY ${orderParts.join(", ")}`;
    }
  }

  // LIMIT / OFFSET
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
 * Builds a COUNT query for the number of distinct groups — the groups that
 * survive `$having` when one is given (the same predicate the row query
 * renders, so `$count` agrees with the row set). Returns `{ count: N }` when
 * executed.
 */
export function buildAggregateCount(
  dialect: SqlDialect,
  table: string,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  const groupFields = controls.$groupBy as string[] | undefined;
  const having = havingClause(dialect, controls);
  const countCol = `COUNT(*) AS ${dialect.quoteIdentifier("count")}`;
  if (!groupFields?.length && !having) {
    // No groupBy — just count all matching rows
    const sql = `SELECT ${countCol} FROM ${dialect.quoteTable(table)} WHERE ${where.sql}`;
    return finalizeParams(dialect, { sql, params: where.params });
  }

  // HAVING without GROUP BY treats the whole table as one group (0 or 1).
  // The inner select must then be an aggregate — SQLite rejects
  // `SELECT 1 … HAVING` without GROUP BY — so it counts instead of `SELECT 1`;
  // the subquery keeps the outer COUNT(*) at exactly one row either way.
  // A grouped inner select lists the calendar buckets (`<expr> AS alias`,
  // legal on every dialect) so a HAVING that names one by alias
  // (`SqlDialect.bucketAliasInHaving`) resolves; the expressions are
  // parameter-free, so the bind order is unchanged.
  const groupBy = groupFields?.length
    ? ` GROUP BY ${groupFields.map((key) => groupKeySql(dialect, controls, key)).join(", ")}`
    : "";
  let inner = "COUNT(*)";
  if (groupBy) {
    inner = bucketSelectParts(dialect, controls).join(", ") || "1";
  }
  const sql = `SELECT ${countCol} FROM (SELECT ${inner} FROM ${dialect.quoteTable(table)} WHERE ${where.sql}${groupBy}${having?.sql ?? ""}) AS ${dialect.quoteIdentifier("_groups")}`;
  return finalizeParams(dialect, { sql, params: [...where.params, ...(having?.params ?? [])] });
}
