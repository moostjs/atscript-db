import type { AtscriptQueryFieldRef, TViewColumnMapping, TViewPlan } from "@atscript/db";

import type { SqlDialect } from "./dialect";
import { havingGroupRef } from "./dialect";
import { queryNodeToSql } from "./common";
import { renderAggCall } from "./agg";

/**
 * The SQL expression a view column reads: `"table"."column"` — the physical
 * source column resolved by `AtscriptDbView.getViewColumnMappings()` — or,
 * for a primitive leaf inside a JSON column (`mapping.json`), the dialect's
 * typed {@link SqlDialect.jsonExtract} over that column. Used for SELECT
 * columns, GROUP BY / HAVING dimensions and as an aggregate's source.
 *
 * @throws when the column reads a JSON leaf and the dialect has no `jsonExtract`.
 */
export function viewSourceExpr(dialect: SqlDialect, mapping: TViewColumnMapping): string {
  const col = `${dialect.quoteIdentifier(mapping.sourceTable)}.${dialect.quoteIdentifier(mapping.sourceColumn)}`;
  if (!mapping.json) {
    return col;
  }
  if (!dialect.jsonExtract) {
    throw new Error(
      `View column "${mapping.viewColumn}": JSON extraction is not supported by this adapter`,
    );
  }
  return dialect.jsonExtract(col, mapping.json.path, mapping.json.type);
}

/**
 * The SQL expression of one aggregate view column, e.g. `SUM("orders"."amount")`,
 * `COUNT(*)` or `COUNT(DISTINCT "orders"."customer_id")`, over
 * {@link viewSourceExpr}. The mapping's aggregate rules (`*` only for count, …)
 * are validated where the core builds it.
 *
 * A conditional aggregate (`aggFilter`, rendered with the view's predicate
 * resolver) aggregates `CASE WHEN <predicate> THEN <src> END` — NULL for the
 * rows the predicate rejects, which every aggregate skips:
 * - `COUNT(*)` → `COUNT(CASE WHEN p THEN 1 END)`;
 * - `countDistinct` → `COUNT(DISTINCT CASE WHEN p THEN src END)`;
 * - `sum` → `COALESCE(SUM(CASE WHEN p THEN src END), 0)` — a group with no
 *   matching row sums to 0, not NULL (MongoDB's `$sum` answer too);
 * - `avg` / `min` / `max` stay NULL when no row matches.
 */
export function viewAggExpr(
  dialect: SqlDialect,
  c: TViewColumnMapping,
  resolveFieldRef: (ref: AtscriptQueryFieldRef) => string,
): string {
  const star = c.aggField === "*";
  const src = star ? "*" : viewSourceExpr(dialect, c);
  if (!c.aggFilter) {
    return renderAggCall(c.aggFn, src, c.viewColumn);
  }
  const predicate = queryNodeToSql(c.aggFilter, resolveFieldRef);
  const call = renderAggCall(
    c.aggFn,
    `CASE WHEN ${predicate} THEN ${star ? "1" : src} END`,
    c.viewColumn,
  );
  return c.aggFn === "sum" ? `COALESCE(${call}, 0)` : call;
}

/**
 * Builds a CREATE VIEW statement from a view plan and column mappings.
 *
 * Joins render in declaration order — `JOIN` (inner, the default) or
 * `LEFT JOIN` for `kind: "left"`. Column mappings carry PHYSICAL source
 * names; `resolveFieldRef` renders predicate refs (join ON, WHERE, HAVING
 * fallbacks) as `"table"."column"`.
 */
export function buildCreateView(
  dialect: SqlDialect,
  viewName: string,
  plan: TViewPlan,
  columns: TViewColumnMapping[],
  resolveFieldRef: (ref: AtscriptQueryFieldRef) => string,
): string {
  // SELECT columns — wrap aggregate columns with their function
  const selectCols = columns
    .map((c) => {
      const expr = c.aggFn ? viewAggExpr(dialect, c, resolveFieldRef) : viewSourceExpr(dialect, c);
      return `${expr} AS ${dialect.quoteIdentifier(c.viewColumn)}`;
    })
    .join(", ");

  // FROM entry table
  let sql = `${dialect.createViewPrefix} ${dialect.quoteTable(viewName)} AS SELECT ${selectCols} FROM ${dialect.quoteIdentifier(plan.entryTable)}`;

  // JOINs — declaration order; a later join may reference an earlier one
  for (const join of plan.joins) {
    const onClause = queryNodeToSql(join.condition, resolveFieldRef);
    const keyword = join.kind === "left" ? "LEFT JOIN" : "JOIN";
    sql += ` ${keyword} ${dialect.quoteIdentifier(join.targetTable)} ON ${onClause}`;
  }

  // WHERE filter
  if (plan.filter) {
    const whereClause = queryNodeToSql(plan.filter, resolveFieldRef);
    sql += ` WHERE ${whereClause}`;
  }

  // GROUP BY + HAVING — only when aggregates are present
  const hasAggregates = columns.some((c) => c.aggFn);
  if (hasAggregates) {
    const dimensionCols = columns.filter((c) => !c.aggFn);
    if (dimensionCols.length > 0) {
      const groupByCols = dimensionCols.map((c) => viewSourceExpr(dialect, c)).join(", ");
      sql += ` GROUP BY ${groupByCols}`;
    }

    // HAVING — post-aggregation filter over logical view field names
    if (plan.having) {
      const columnByPath = new Map<string, TViewColumnMapping>();
      for (const c of columns) {
        columnByPath.set(c.viewPath, c);
      }

      const havingResolver = (ref: AtscriptQueryFieldRef): string => {
        const col = ref.type ? undefined : columnByPath.get(ref.field);
        if (!col) {
          return resolveFieldRef(ref);
        }
        if (col.aggFn) {
          return viewAggExpr(dialect, col, resolveFieldRef);
        }
        const expr = viewSourceExpr(dialect, col);
        // A JSON-extracted dimension reads its raw JSON column, which is not
        // itself in GROUP BY — see `havingGroupRef`.
        return col.json ? havingGroupRef(dialect, expr, col.viewColumn) : expr;
      };

      const havingClause = queryNodeToSql(plan.having, havingResolver);
      sql += ` HAVING ${havingClause}`;
    }
  }

  return sql;
}
