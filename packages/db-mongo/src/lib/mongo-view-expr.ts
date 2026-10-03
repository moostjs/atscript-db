import {
  isFieldRef,
  type AtscriptExprNode,
  type AtscriptQueryFieldRef,
  type AtscriptQueryNode,
} from "@atscript/db";
import type { Document } from "mongodb";

/**
 * Resolves a predicate field ref to an aggregation expression operand:
 * `"$path"` for a field of the current document, `"$$var"` for a `$lookup`
 * `let` variable.
 */
export type TViewExprPathOf = (ref: AtscriptQueryFieldRef) => string;

/**
 * `x IS NOT NULL` in SQL terms — true when `x` is neither null nor missing.
 * Aggregation order puts a missing value below null and every other value
 * above it, so one comparison covers both (`{ $ne: [x, null] }` alone would
 * be true for a MISSING field).
 * @since 0.1.136
 */
export function notNullExpr(x: unknown): Document {
  return { $gt: [x, null] };
}

/** `x IS NULL` in SQL terms — true when `x` is null or missing (see {@link notNullExpr}). @since 0.1.136 */
export function isNullExpr(x: unknown): Document {
  return { $lte: [x, null] };
}

/**
 * `x`, with a missing value read as null — for a projected column (a missing
 * key would drop it from the row) and a `$group` key (missing and null would
 * form two groups). Only where a value may be missing: the wrapper hides the
 * path from `$match` / `$sort` pushdown.
 * @since 0.1.136
 */
export function orNull(x: unknown): Document {
  return { $ifNull: [x, null] };
}

/** A literal inside `$expr` — `$`-prefixed strings would otherwise read as field paths. */
function literal(value: unknown): unknown {
  return typeof value === "string" && value.startsWith("$") ? { $literal: value } : value;
}

const COMPARISONS: Readonly<Record<string, string>> = {
  $eq: "$eq",
  $ne: "$ne",
  $gt: "$gt",
  $gte: "$gte",
  $lt: "$lt",
  $lte: "$lte",
};

/** `cond` AND-guarded so that every field operand is non-null (SQL: NULL operand → not true). */
function guarded(operands: unknown[], cond: Document): Document {
  return { $and: [...operands.map((o) => notNullExpr(o)), cond] };
}

/**
 * Field-to-field comparison `x <op> y` (`$eq` … `$lte`): both operands must
 * be non-null (SQL `NULL = NULL` is UNKNOWN) — view predicates and
 * `buildMongoFilter`'s field operands.
 * @since 0.1.137
 */
export function fieldCompareExpr(op: string, x: unknown, y: unknown): Document {
  return guarded([x, y], { [op]: [x, y] });
}

/**
 * Translates a view predicate (join condition, conditional-aggregate filter)
 * to an aggregation expression for `$match: { $expr }` / `$cond`, matching
 * SQL's three-valued logic wherever a NULL operand makes SQL's comparison
 * UNKNOWN (treated as false):
 *
 * - `<`, `<=`, `>`, `>=`, `!= <literal>`, field `=` field, field `!=` field
 *   and `not in` are guarded with "every field operand is not null";
 * - `= null` / `not exists` → null-or-missing; `!= null` / `exists` → neither;
 * - `= <literal>` and `in (…)` compare directly (a null operand never equals
 *   a non-null literal); an empty `not in` is true;
 * - `and` / `or` / `not` map directly — so `not (x > 1)` is TRUE for a null
 *   `x` here while SQL yields UNKNOWN (documented divergence);
 * - `matches` is rejected (`$regexMatch` needs MongoDB 4.2).
 * @since 0.1.136
 */
export function queryNodeToExpr(node: AtscriptQueryNode, pathOf: TViewExprPathOf): Document {
  if ("$and" in node) {
    return {
      $and: (node as { $and: AtscriptQueryNode[] }).$and.map((n) => queryNodeToExpr(n, pathOf)),
    };
  }
  if ("$or" in node) {
    return {
      $or: (node as { $or: AtscriptQueryNode[] }).$or.map((n) => queryNodeToExpr(n, pathOf)),
    };
  }
  if ("$not" in node) {
    return { $not: [queryNodeToExpr((node as { $not: AtscriptQueryNode }).$not, pathOf)] };
  }

  const comp = node as { left: AtscriptQueryFieldRef; op: string; right?: unknown };
  const x = pathOf(comp.left);

  switch (comp.op) {
    case "$exists": {
      return comp.right === false ? isNullExpr(x) : notNullExpr(x);
    }
    case "$in": {
      const values = Array.isArray(comp.right) ? comp.right : [comp.right];
      return { $in: [x, values.map((v) => literal(v))] };
    }
    case "$nin": {
      const values = Array.isArray(comp.right) ? comp.right : [comp.right];
      if (values.length === 0) {
        return { $literal: true } as Document;
      }
      return guarded([x], { $not: [{ $in: [x, values.map((v) => literal(v))] }] });
    }
    case "$regex": {
      throw new Error("matches is not supported in view predicates");
    }
    default:
  }

  const op = COMPARISONS[comp.op];
  if (!op) {
    throw new Error(`Operator "${comp.op}" is not supported in view predicates`);
  }

  if (isFieldRef(comp.right)) {
    return fieldCompareExpr(op, x, pathOf(comp.right));
  }

  if (comp.right === null || comp.right === undefined) {
    if (op === "$eq") return isNullExpr(x);
    if (op === "$ne") return notNullExpr(x);
    // `x < NULL` is UNKNOWN for every x in SQL
    return { $literal: false } as Document;
  }

  const value = literal(comp.right);
  if (op === "$eq") {
    return { $eq: [x, value] };
  }
  return guarded([x], { [op]: [x, value] });
}

/**
 * A computed view column (`@db.compute`) as an aggregation expression:
 * `$add` / `$subtract` / `$multiply`; `/` → `$divide` guarded so a zero
 * divisor yields null (`$divide` by 0 is an error in MongoDB); unary minus →
 * `$multiply` by -1; `coalesce` → nested two-argument `$ifNull` (the
 * multi-argument form needs MongoDB 5.0). A null or missing operand yields
 * null, like SQL. Evaluated in double like the SQL adapters (MongoDB 4.0+):
 * literals render `{ $toDouble: n }` and `operand` — which renders a field
 * leaf (a view path) — must return a double too (`$toDouble` over a plain
 * column; a computed operand is one already). Without the casts int/long
 * arithmetic would stay exact past 2^53 where SQL rounds.
 * @since 0.1.147
 */
export function exprToMongo(node: AtscriptExprNode, operand: (path: string) => unknown): unknown {
  if (typeof node === "number") return { $toDouble: node };
  if ("field" in node) return operand(node.field);
  const args = node.args.map((arg) => exprToMongo(arg, operand));
  switch (node.op) {
    case "+": {
      return { $add: args };
    }
    case "-": {
      return { $subtract: args };
    }
    case "*": {
      return { $multiply: args };
    }
    case "/": {
      return { $cond: [{ $eq: [args[1], 0] }, null, { $divide: args }] };
    }
    case "neg": {
      return { $multiply: [-1, args[0]] };
    }
    default: {
      // coalesce
      return args.reduceRight((rest, arg) => ({ $ifNull: [arg, rest] }));
    }
  }
}
