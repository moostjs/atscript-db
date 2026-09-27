import type { TDbReferentialAction } from "@atscript/db";
import { DbError, isFieldRef } from "@atscript/db";
import { TIME_ZONE_NAME_RE } from "@uniqu/core";
import type { AtscriptQueryNode, AtscriptQueryFieldRef } from "@atscript/db";

import { EMPTY_AND, EMPTY_OR, quotedJsonPathSegments } from "./dialect";

/** Formats a string value as a SQL literal with single-quote escaping. */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The SQL string literal of a `$`-rooted JSON path with every segment quoted
 * (`'$."a"."b"'`) — the path argument of SQLite's and MySQL's `json_extract` /
 * `json_type`.
 *
 * @since 0.1.136
 * @throws as {@link quotedJsonPathSegments}.
 */
export function jsonDollarPath(path: readonly string[]): string {
  return sqlStringLiteral(`$.${quotedJsonPathSegments(path).join(".")}`);
}

/**
 * A calendar bucket's time zone as an inlined SQL string literal (`'Europe/Berlin'`).
 *
 * The zone is already canonical (the core normalizer ran uniqu's
 * `checkTimeZone`); this re-asserts uniqu's `TIME_ZONE_NAME_RE` charset —
 * no quote, backslash or whitespace can reach the literal — as defense in
 * depth for dialects that inline it (bucket expressions are parameter-free).
 *
 * @throws DbError `INVALID_QUERY` for a name outside the charset.
 */
export function sqlTimeZoneLiteral(tz: string): string {
  if (!TIME_ZONE_NAME_RE.test(tz)) {
    throw new DbError("INVALID_QUERY", [{ path: "$select", message: `Unknown time zone "${tz}"` }]);
  }
  return `'${tz}'`;
}

/** Converts a JS value to a SQL-bindable parameter. Objects/arrays -> JSON, booleans -> 0/1. */
export function toSqlValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return null;
  }
  if (value instanceof Uint8Array) {
    // Binary param (BLOB / geometry / vector) — pass through to the driver,
    // JSON.stringify would mangle it into '{"type":"Buffer",...}'.
    return value;
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

/** An inlined SQL literal for a view-predicate value (DDL — no parameters). */
function predicateLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "string") {
    return sqlStringLiteral(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Non-finite number ${value} in a view predicate`);
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  throw new Error(`Unsupported literal ${JSON.stringify(value)} in a view predicate`);
}

/**
 * Renders an AtscriptQueryNode tree to raw SQL (no parameters -- for DDL use only).
 *
 * Operators: `=`/`!=`/`<`/`<=`/`>`/`>=` (a `null` operand becomes `IS [NOT] NULL`),
 * `in` / `not in` (inlined literals; an empty `in` is `0=1`, an empty
 * `not in` `1=1`), `exists` → `IS NOT NULL`, `not exists` → `IS NULL`.
 *
 * @throws for `matches` (`$regex`) and any other operator — a view predicate
 *   that cannot be rendered fails at sync instead of rendering wrong SQL.
 */
export function queryNodeToSql(
  node: AtscriptQueryNode,
  resolveFieldRef: (ref: AtscriptQueryFieldRef) => string,
): string {
  if ("$and" in node) {
    const children = (node as { $and: AtscriptQueryNode[] }).$and;
    if (children.length === 0) {
      return EMPTY_AND.sql;
    }
    return children.map((n) => queryNodeToSql(n, resolveFieldRef)).join(" AND ");
  }
  if ("$or" in node) {
    const children = (node as { $or: AtscriptQueryNode[] }).$or;
    if (children.length === 0) {
      return EMPTY_OR.sql;
    }
    return `(${children.map((n) => queryNodeToSql(n, resolveFieldRef)).join(" OR ")})`;
  }
  if ("$not" in node) {
    return `NOT (${queryNodeToSql((node as { $not: AtscriptQueryNode }).$not, resolveFieldRef)})`;
  }

  // Comparison
  const comp = node as { left: AtscriptQueryFieldRef; op: string; right?: unknown };
  const leftSql = resolveFieldRef(comp.left);

  switch (comp.op) {
    case "$exists": {
      return comp.right === false ? `${leftSql} IS NULL` : `${leftSql} IS NOT NULL`;
    }
    case "$in":
    case "$nin": {
      const values = Array.isArray(comp.right) ? comp.right : [comp.right];
      if (values.length === 0) {
        return comp.op === "$in" ? EMPTY_OR.sql : EMPTY_AND.sql;
      }
      const list = values.map((v) => predicateLiteral(v)).join(", ");
      return `${leftSql} ${comp.op === "$in" ? "IN" : "NOT IN"} (${list})`;
    }
    case "$regex": {
      throw new Error("matches is not supported in view predicates");
    }
    default:
  }

  const sqlOp = queryOpToSql[comp.op];
  if (!sqlOp) {
    throw new Error(`Operator "${comp.op}" is not supported in view predicates`);
  }

  // Field-to-field comparison
  if (isFieldRef(comp.right)) {
    return `${leftSql} ${sqlOp} ${resolveFieldRef(comp.right)}`;
  }

  // Value comparison
  if (comp.right === null || comp.right === undefined) {
    return comp.op === "$ne" ? `${leftSql} IS NOT NULL` : `${leftSql} IS NULL`;
  }
  return `${leftSql} ${sqlOp} ${predicateLiteral(comp.right)}`;
}
