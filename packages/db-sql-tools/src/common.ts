import type { TDbReferentialAction } from "@atscript/db";
import type { AtscriptQueryNode, AtscriptQueryFieldRef } from "@atscript/db";

/** Formats a string value as a SQL literal with single-quote escaping. */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Converts a JS value to a SQL-bindable parameter. Objects/arrays -> JSON, booleans -> 0/1. */
export function toSqlValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}

export function refActionToSql(action: TDbReferentialAction): string {
  switch (action) {
    case "cascade": {
      return "CASCADE";
    }
    case "restrict": {
      return "RESTRICT";
    }
    case "setNull": {
      return "SET NULL";
    }
    case "setDefault": {
      return "SET DEFAULT";
    }
    default: {
      return "NO ACTION";
    }
  }
}

/** Returns a safe SQL DEFAULT literal for a given design type. */
export function defaultValueForType(designType: string): string {
  switch (designType) {
    case "number":
    case "integer": {
      return "0";
    }
    case "boolean": {
      return "0";
    }
    case "decimal": {
      return "'0'";
    }
    default: {
      return "''";
    }
  }
}

/**
 * Converts a stored default value string to a SQL DEFAULT literal,
 * respecting the field's designType. Booleans become 0/1, numbers stay unquoted,
 * strings are single-quote-escaped.
 */
export function defaultValueToSqlLiteral(designType: string, value: string): string {
  switch (designType) {
    case "boolean": {
      return value === "true" || value === "1" ? "1" : "0";
    }
    case "number":
    case "integer":
    case "decimal": {
      const n = Number(value);
      return Number.isFinite(n) ? String(n) : "0";
    }
    default: {
      return sqlStringLiteral(value);
    }
  }
}

export const queryOpToSql: Record<string, string> = {
  $eq: "=",
  $ne: "!=",
  $gt: ">",
  $gte: ">=",
  $lt: "<",
  $lte: "<=",
};

/**
 * Renders an AtscriptQueryNode tree to raw SQL (no parameters -- for DDL use only).
 */
export function queryNodeToSql(
  node: AtscriptQueryNode,
  resolveFieldRef: (ref: AtscriptQueryFieldRef) => string,
): string {
  if ("$and" in node) {
    const children = (node as { $and: AtscriptQueryNode[] }).$and;
    return children.map((n) => queryNodeToSql(n, resolveFieldRef)).join(" AND ");
  }
  if ("$or" in node) {
    const children = (node as { $or: AtscriptQueryNode[] }).$or;
    return `(${children.map((n) => queryNodeToSql(n, resolveFieldRef)).join(" OR ")})`;
  }
  if ("$not" in node) {
    return `NOT (${queryNodeToSql((node as { $not: AtscriptQueryNode }).$not, resolveFieldRef)})`;
  }

  // Comparison
  const comp = node as { left: AtscriptQueryFieldRef; op: string; right?: unknown };
  const leftSql = resolveFieldRef(comp.left);
  const sqlOp = queryOpToSql[comp.op] || "=";

  // Field-to-field comparison
  if (comp.right && typeof comp.right === "object" && "field" in (comp.right as object)) {
    return `${leftSql} ${sqlOp} ${resolveFieldRef(comp.right as AtscriptQueryFieldRef)}`;
  }

  // Value comparison
  if (comp.right === null || comp.right === undefined) {
    return comp.op === "$ne" ? `${leftSql} IS NOT NULL` : `${leftSql} IS NULL`;
  }
  if (typeof comp.right === "string") {
    return `${leftSql} ${sqlOp} '${comp.right.replace(/'/g, "''")}'`;
  }
  return `${leftSql} ${sqlOp} ${comp.right as number}`;
}
