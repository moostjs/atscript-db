import type { DbControls, UniquSelect, TFieldOps } from "@atscript/db";
import type { AtscriptQueryFieldRef, TViewColumnMapping, TViewPlan } from "@atscript/db";

import type { SqlDialect, TSqlFragment } from "./dialect";
import { finalizeParams } from "./dialect";
import { queryNodeToSql } from "./common";
import { AGG_FN_SQL } from "./agg";

/**
 * Builds an INSERT statement.
 */
export function buildInsert(
  dialect: SqlDialect,
  table: string,
  data: Record<string, unknown>,
): TSqlFragment {
  const keys = Object.keys(data);
  const cols = keys.map((k) => dialect.quoteIdentifier(k)).join(", ");
  const placeholders = keys.map(() => "?").join(", ");
  return finalizeParams(dialect, {
    sql: `INSERT INTO ${dialect.quoteTable(table)} (${cols}) VALUES (${placeholders})`,
    params: keys.map((k) => dialect.toValue(data[k])),
  });
}

/**
 * Builds a SELECT statement with optional sort, limit, offset, projection.
 */
export function buildSelect(
  dialect: SqlDialect,
  table: string,
  where: TSqlFragment,
  controls?: DbControls,
): TSqlFragment {
  const cols = buildProjection(dialect, controls?.$select);
  let sql = `SELECT ${cols} FROM ${dialect.quoteTable(table)} WHERE ${where.sql}`;
  const params = [...where.params];

  if (controls?.$sort) {
    const orderParts: string[] = [];
    for (const [col, dir] of Object.entries(controls.$sort)) {
      orderParts.push(`${dialect.quoteIdentifier(col)} ${dir === -1 ? "DESC" : "ASC"}`);
    }
    if (orderParts.length > 0) {
      sql += ` ORDER BY ${orderParts.join(", ")}`;
    }
  }

  if (controls?.$limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(controls.$limit);
  }

  if (controls?.$skip !== undefined) {
    if (controls.$limit === undefined) {
      sql += ` LIMIT ${dialect.unlimitedLimit}`;
    }
    sql += ` OFFSET ?`;
    params.push(controls.$skip);
  }

  return finalizeParams(dialect, { sql, params });
}

/**
 * Builds an UPDATE ... SET ... WHERE statement with optional LIMIT.
 */
export function buildUpdate(
  dialect: SqlDialect,
  table: string,
  data: Record<string, unknown>,
  where: TSqlFragment,
  limit?: number,
  ops?: TFieldOps,
): TSqlFragment {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(data)) {
    setClauses.push(`${dialect.quoteIdentifier(key)} = ?`);
    params.push(dialect.toValue(value));
  }

  // Append pre-separated field operations
  if (ops?.inc) {
    for (const key in ops.inc) {
      const col = dialect.quoteIdentifier(key);
      setClauses.push(`${col} = ${col} + ?`);
      params.push(ops.inc[key]!);
    }
  }
  if (ops?.mul) {
    for (const key in ops.mul) {
      const col = dialect.quoteIdentifier(key);
      setClauses.push(`${col} = ${col} * ?`);
      params.push(ops.mul[key]!);
    }
  }

  let sql = `UPDATE ${dialect.quoteTable(table)} SET ${setClauses.join(", ")} WHERE ${where.sql}`;
  if (limit !== undefined) {
    sql += ` LIMIT ${limit}`;
  }

  return finalizeParams(dialect, {
    sql,
    params: [...params, ...where.params],
  });
}

/**
 * Builds a DELETE ... WHERE statement with optional LIMIT.
 */
export function buildDelete(
  dialect: SqlDialect,
  table: string,
  where: TSqlFragment,
  limit?: number,
): TSqlFragment {
  let sql = `DELETE FROM ${dialect.quoteTable(table)} WHERE ${where.sql}`;
  if (limit !== undefined) {
    sql += ` LIMIT ${limit}`;
  }
  return finalizeParams(dialect, { sql, params: where.params });
}

/**
 * Builds a column projection (SELECT clause fields).
 */
export function buildProjection(dialect: SqlDialect, select?: UniquSelect): string {
  const fields = select?.asArray;
  if (!fields) {
    return "*";
  }
  let sql = "";
  for (let i = 0; i < fields.length; i++) {
    if (i > 0) {
      sql += ", ";
    }
    sql += dialect.quoteIdentifier(fields[i]);
  }
  return sql || "*";
}

/** Builds the SQL expression for a single aggregate column. */
function buildAggColExpr(dialect: SqlDialect, c: TViewColumnMapping): string {
  const fn = AGG_FN_SQL[c.aggFn!] ?? c.aggFn!.toUpperCase();
  const arg =
    c.aggField === "*"
      ? "*"
      : `${dialect.quoteIdentifier(c.sourceTable)}.${dialect.quoteIdentifier(c.sourceColumn)}`;
  return `${fn}(${arg})`;
}

/**
 * Builds a CREATE VIEW statement from a view plan and column mappings.
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
      if (c.aggFn) {
        return `${buildAggColExpr(dialect, c)} AS ${dialect.quoteIdentifier(c.viewColumn)}`;
      }
      return `${dialect.quoteIdentifier(c.sourceTable)}.${dialect.quoteIdentifier(c.sourceColumn)} AS ${dialect.quoteIdentifier(c.viewColumn)}`;
    })
    .join(", ");

  // FROM entry table
  let sql = `${dialect.createViewPrefix} ${dialect.quoteTable(viewName)} AS SELECT ${selectCols} FROM ${dialect.quoteIdentifier(plan.entryTable)}`;

  // JOINs
  for (const join of plan.joins) {
    const onClause = queryNodeToSql(join.condition, resolveFieldRef);
    sql += ` JOIN ${dialect.quoteIdentifier(join.targetTable)} ON ${onClause}`;
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
      const groupByCols = dimensionCols
        .map(
          (c) =>
            `${dialect.quoteIdentifier(c.sourceTable)}.${dialect.quoteIdentifier(c.sourceColumn)}`,
        )
        .join(", ");
      sql += ` GROUP BY ${groupByCols}`;
    }

    // HAVING — post-aggregation filter
    if (plan.having) {
      const columnMap = new Map<string, TViewColumnMapping>();
      for (const c of columns) {
        columnMap.set(c.viewColumn, c);
      }

      const havingResolver = (ref: AtscriptQueryFieldRef): string => {
        if (!ref.type) {
          const col = columnMap.get(ref.field);
          if (col?.aggFn) {
            return buildAggColExpr(dialect, col);
          }
          if (col) {
            return `${dialect.quoteIdentifier(col.sourceTable)}.${dialect.quoteIdentifier(col.sourceColumn)}`;
          }
        }
        return resolveFieldRef(ref);
      };

      const havingClause = queryNodeToSql(plan.having, havingResolver);
      sql += ` HAVING ${havingClause}`;
    }
  }

  return sql;
}
