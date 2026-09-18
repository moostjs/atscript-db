import { type AggregateExpr, walkFilter } from "@uniqu/core";
import type { DbControls } from "@atscript/db";
import { resolveAlias } from "@atscript/db/agg";

import type { SqlDialect, TSqlFragment } from "./dialect";
import { EMPTY_AND, finalizeParams } from "./dialect";
import { buildWhere, createFilterVisitor } from "./filter-builder";

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

/**
 * Renders `$having`. A key that names an aggregate alias (`$as`, else
 * `fn_field`) renders the aggregate expression itself — `SUM("amount") > ?`
 * — because PostgreSQL does not allow a SELECT alias in HAVING (MySQL and
 * SQLite tolerate it, so the expression form keeps all three identical).
 * Other keys (grouped columns) render as plain columns.
 */
function buildHaving(dialect: SqlDialect, controls: DbControls): TSqlFragment {
  const having = controls.$having!;
  const aggregates = controls.$select?.aggregates;
  if (!aggregates?.length) {
    return buildWhere(dialect, having);
  }
  const exprByAlias = new Map<string, string>();
  for (const expr of aggregates) {
    exprByAlias.set(resolveAlias(expr), aggFnSql(dialect, expr));
  }
  const visitor = createFilterVisitor(dialect, {
    columnRef: (field) => exprByAlias.get(field) ?? dialect.quoteIdentifier(field),
  });
  return walkFilter(having, visitor) ?? EMPTY_AND;
}

/**
 * Builds a SELECT ... GROUP BY statement with aggregate functions.
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
    const groupCols = groupBy.map((f) => dialect.quoteIdentifier(f)).join(", ");
    sql += ` GROUP BY ${groupCols}`;
  }

  // HAVING
  if (controls.$having) {
    const havingFragment = buildHaving(dialect, controls);
    if (havingFragment.sql !== EMPTY_AND.sql) {
      sql += ` HAVING ${havingFragment.sql}`;
      params.push(...havingFragment.params);
    }
  }

  // ORDER BY
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
 * Builds a COUNT query for the number of distinct groups.
 * Returns `{ count: N }` when executed.
 */
export function buildAggregateCount(
  dialect: SqlDialect,
  table: string,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  const groupFields = controls.$groupBy as string[] | undefined;
  if (!groupFields?.length) {
    // No groupBy — just count all matching rows
    const sql = `SELECT COUNT(*) AS ${dialect.quoteIdentifier("count")} FROM ${dialect.quoteTable(table)} WHERE ${where.sql}`;
    return finalizeParams(dialect, { sql, params: where.params });
  }

  const groupCols = groupFields.map((f) => dialect.quoteIdentifier(f)).join(", ");
  const sql = `SELECT COUNT(*) AS ${dialect.quoteIdentifier("count")} FROM (SELECT 1 FROM ${dialect.quoteTable(table)} WHERE ${where.sql} GROUP BY ${groupCols}) AS ${dialect.quoteIdentifier("_groups")}`;
  return finalizeParams(dialect, { sql, params: where.params });
}
