import { type AggregateExpr, walkFilter } from "@uniqu/core";
import type { DbControls } from "@atscript/db";
import { resolveAlias } from "@atscript/db/agg";

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

/**
 * ` HAVING <predicate>` (leading space) + params for `controls.$having`, or
 * `undefined` when there is nothing to render. Shared by the row and the
 * count builders so both filter the same group set.
 *
 * A key that names an aggregate alias (`$as`, else `fn_field`) renders the
 * aggregate expression itself — `SUM("amount") > ?` — because PostgreSQL does
 * not allow a SELECT alias in HAVING (MySQL and SQLite tolerate it, so the
 * expression form keeps all three identical). Other keys (grouped columns)
 * render as plain columns.
 */
function havingClause(dialect: SqlDialect, controls: DbControls): TSqlFragment | undefined {
  const having = controls.$having;
  if (!having) return undefined;
  const exprByAlias = new Map<string, string>();
  for (const expr of controls.$select?.aggregates ?? []) {
    exprByAlias.set(resolveAlias(expr), aggFnSql(dialect, expr));
  }
  const visitor = createFilterVisitor(dialect, {
    columnRef: (field) => exprByAlias.get(field) ?? dialect.quoteIdentifier(field),
  });
  const fragment = walkFilter(having, visitor);
  if (!fragment || fragment.sql === EMPTY_AND.sql) return undefined;
  return { sql: ` HAVING ${fragment.sql}`, params: fragment.params };
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
  const having = havingClause(dialect, controls);
  if (having) {
    sql += having.sql;
    params.push(...having.params);
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
  const groupBy = groupFields?.length
    ? ` GROUP BY ${groupFields.map((f) => dialect.quoteIdentifier(f)).join(", ")}`
    : "";
  const inner = groupBy ? "1" : "COUNT(*)";
  const sql = `SELECT ${countCol} FROM (SELECT ${inner} FROM ${dialect.quoteTable(table)} WHERE ${where.sql}${groupBy}${having?.sql ?? ""}) AS ${dialect.quoteIdentifier("_groups")}`;
  return finalizeParams(dialect, { sql, params: [...where.params, ...(having?.params ?? [])] });
}
