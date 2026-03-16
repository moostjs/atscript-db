import { walkFilter, type FilterExpr, type FilterVisitor } from "@uniqu/core";

import type { SqlDialect, TSqlFragment } from "./dialect";
import { EMPTY_AND, EMPTY_OR } from "./dialect";

/**
 * Creates a dialect-specific filter visitor for `walkFilter`.
 */
export function createFilterVisitor(dialect: SqlDialect): FilterVisitor<TSqlFragment> {
  return {
    comparison(field, op, value) {
      const col = dialect.quoteIdentifier(field);
      const v = dialect.toParam(value);

      switch (op) {
        case "$eq": {
          if (v === null) {
            return { sql: `${col} IS NULL`, params: [] };
          }
          return { sql: `${col} = ?`, params: [v] };
        }
        case "$ne": {
          if (v === null) {
            return { sql: `${col} IS NOT NULL`, params: [] };
          }
          return { sql: `${col} != ?`, params: [v] };
        }
        case "$gt": {
          return { sql: `${col} > ?`, params: [v] };
        }
        case "$gte": {
          return { sql: `${col} >= ?`, params: [v] };
        }
        case "$lt": {
          return { sql: `${col} < ?`, params: [v] };
        }
        case "$lte": {
          return { sql: `${col} <= ?`, params: [v] };
        }
        case "$in": {
          const arr = (value as unknown[]).map((x) => dialect.toParam(x));
          if (arr.length === 0) {
            return EMPTY_OR;
          }
          const placeholders = arr.map(() => "?").join(", ");
          return { sql: `${col} IN (${placeholders})`, params: arr };
        }
        case "$nin": {
          const arr = (value as unknown[]).map((x) => dialect.toParam(x));
          if (arr.length === 0) {
            return EMPTY_AND;
          }
          const placeholders = arr.map(() => "?").join(", ");
          return { sql: `${col} NOT IN (${placeholders})`, params: arr };
        }
        case "$exists": {
          return value
            ? { sql: `${col} IS NOT NULL`, params: [] }
            : { sql: `${col} IS NULL`, params: [] };
        }
        case "$regex": {
          return dialect.regex(col, value);
        }
        default: {
          throw new Error(`Unsupported filter operator: ${String(op)}`);
        }
      }
    },

    and(children) {
      if (children.length === 0) {
        return EMPTY_AND;
      }
      return {
        sql: children.map((c) => c.sql).join(" AND "),
        params: children.flatMap((c) => c.params),
      };
    },

    or(children) {
      if (children.length === 0) {
        return EMPTY_OR;
      }
      return {
        sql: `(${children.map((c) => c.sql).join(" OR ")})`,
        params: children.flatMap((c) => c.params),
      };
    },

    not(child) {
      return {
        sql: `NOT (${child.sql})`,
        params: child.params,
      };
    },
  };
}

const visitorCache = new WeakMap<SqlDialect, FilterVisitor<TSqlFragment>>();

function getVisitor(dialect: SqlDialect): FilterVisitor<TSqlFragment> {
  let visitor = visitorCache.get(dialect);
  if (!visitor) {
    visitor = createFilterVisitor(dialect);
    visitorCache.set(dialect, visitor);
  }
  return visitor;
}

/**
 * Translates a filter expression into a parameterized SQL WHERE clause.
 */
export function buildWhere(dialect: SqlDialect, filter: FilterExpr): TSqlFragment {
  if (!filter || Object.keys(filter).length === 0) {
    return EMPTY_AND;
  }
  return walkFilter(filter, getVisitor(dialect)) ?? EMPTY_AND;
}
