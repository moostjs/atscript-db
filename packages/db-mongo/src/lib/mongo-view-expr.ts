import {
  DbError,
  INTEGER_REGEX_OP,
  isFieldRef,
  walkFilter,
  type AtscriptExprNode,
  type AtscriptQueryFieldRef,
  type AtscriptQueryNode,
  type FilterExpr,
  type FilterVisitor,
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

// ── Conditions of conditional aggregates ─────────────────────────────────────

/**
 * A boolean aggregation expression. Constants are `{ $literal: … }` objects,
 * never a bare `true` / `false`: a caller testing a condition for presence
 * must never mistake "always false" for "no condition".
 */
type TCond = Document;

const TRUE_COND: TCond = { $literal: true };
const FALSE_COND: TCond = { $literal: false };

/**
 * A condition's value inside an expression: a `$`-string would read as a
 * field path and an object as an expression object — both stay literals.
 */
function valueOf(value: unknown): unknown {
  const literalObject = value !== null && typeof value === "object" && !(value instanceof Date);
  return literalObject ? { $literal: value } : literal(value);
}

const not = (cond: TCond): TCond => ({ $not: [cond] });
const allOf = (items: TCond[]): TCond =>
  items.length === 0 ? TRUE_COND : items.length === 1 ? items[0]! : { $and: items };
const anyOf = (items: TCond[]): TCond =>
  items.length === 0 ? FALSE_COND : items.length === 1 ? items[0]! : { $or: items };

/** `test(x)` for a scalar `x`; for an array, true when ANY element passes (the query filter's array reading). */
function eachValue(x: unknown, test: (value: unknown) => TCond): TCond {
  return {
    $cond: [
      { $isArray: x },
      { $anyElementTrue: [{ $map: { input: x, as: "v", in: test("$$v") } }] },
      test(x),
    ],
  };
}

/** A `$regex` value — a RegExp, a `/pattern/flags` string or a bare pattern — as pattern + flags. */
export function parseRegexString(value: unknown): { pattern: string; flags: string } {
  if (value instanceof RegExp) {
    return { pattern: value.source, flags: value.flags };
  }
  const str = String(value);
  const match = str.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    return { pattern: match[1]!, flags: match[2]! };
  }
  return { pattern: str, flags: "" };
}

/** `$regexMatch` options: the PCRE flags it accepts (`g` / `u` / `y` mean nothing there). */
function regexParts(value: unknown): { regex: string; options?: string } {
  const { pattern, flags } = parseRegexString(value);
  const options = flags.replace(/[^imsx]/g, "");
  return options ? { regex: pattern, options } : { regex: pattern };
}

/**
 * A pattern over the DECIMAL TEXT of an integer operand (`INTEGER_REGEX_OP`)
 * — the query filter's and a `$where` condition's rendering. The inner
 * `$convert` to long is required (a double prints as `1e+16`); a
 * non-numeric / missing value converts to null → `$regexMatch` is false.
 */
export function integerRegexExpr(input: unknown, value: unknown): Document {
  const long = { $convert: { input, to: "long", onError: null, onNull: null } };
  return { $regexMatch: { input: { $toString: long }, ...regexParts(value) } };
}

/** A pattern match: a string value (or an array holding one) that matches; any other value does not. */
function regexCond(x: unknown, value: unknown): TCond {
  const parts = regexParts(value);
  return eachValue(x, (v) => ({
    $cond: [{ $eq: [{ $type: v }, "string"] }, { $regexMatch: { input: v, ...parts } }, false],
  }));
}

/**
 * `x = value` as the query filter reads it: `null` matches null, missing and
 * an array holding null; a RegExp matches like `$regex`; any other value
 * matches an equal value or an array holding one.
 */
function eqCond(x: unknown, value: unknown): TCond {
  if (value === null || value === undefined) {
    return { $cond: [{ $isArray: x }, { $in: [null, x] }, isNullExpr(x)] };
  }
  if (value instanceof RegExp) return regexCond(x, value);
  const v = valueOf(value);
  if (Array.isArray(value)) return { $eq: [x, v] };
  return { $cond: [{ $isArray: x }, { $in: [v, x] }, { $eq: [x, v] }] };
}

/** The comparison-class test of a range operand: only values of the operand's BSON class compare. */
function sameClass(v: unknown, value: unknown): TCond {
  if (typeof value === "number" || typeof value === "bigint") return { $isNumber: v };
  return { $eq: [{ $type: v }, { $type: valueOf(value) }] };
}

/**
 * `x <op> value` for `$gt` / `$gte` / `$lt` / `$lte` as the query filter reads
 * it: only a value of the operand's type class compares (no cross-type order),
 * an array matches when an element does; against `null`, `$gte` / `$lte` are
 * `= null` and `$gt` / `$lt` match nothing.
 */
function rangeCond(x: unknown, op: string, value: unknown): TCond {
  if (value === null || value === undefined) {
    return op === "$gte" || op === "$lte" ? eqCond(x, null) : FALSE_COND;
  }
  const v = valueOf(value);
  return eachValue(x, (el) => ({ $and: [sameClass(el, value), { [op]: [el, v] }] }));
}

function comparisonCond(x: unknown, op: string, value: unknown): TCond {
  switch (op) {
    case "$eq": {
      return eqCond(x, value);
    }
    case "$ne": {
      return not(eqCond(x, value));
    }
    case "$exists": {
      // "holds a value" — a stored null counts as absent (the query filter's `$exists`)
      return value ? not(eqCond(x, null)) : eqCond(x, null);
    }
    case "$in":
    case "$nin": {
      const values = Array.isArray(value) ? value : [value];
      const any = anyOf(values.map((v) => eqCond(x, v)));
      return op === "$in" ? any : not(any);
    }
    case "$regex": {
      return regexCond(x, value);
    }
    case INTEGER_REGEX_OP: {
      return integerRegexExpr(x, value);
    }
    case "$gt":
    case "$gte":
    case "$lt":
    case "$lte": {
      return rangeCond(x, op, value);
    }
    default: {
      throw new DbError("INVALID_QUERY", [
        { path: "$select", message: `Operator "${op}" is not supported in a $where condition` },
      ]);
    }
  }
}

const condVisitor: FilterVisitor<TCond> = {
  comparison: (field, op, value) => comparisonCond(`$${field}`, op, value),
  and: (children) => allOf(children),
  or: (children) => anyOf(children),
  not: (child) => not(child),
  relation: (field) => {
    // the core rejects them before dispatch — a condition reads the row's own columns
    throw new DbError("INVALID_QUERY", [
      { path: field, message: "Relational predicates are not supported in a $where condition" },
    ]);
  },
};

/**
 * The condition of a conditional aggregate (`$where`: a uniqu filter,
 * translated — physical names, storage values) as an aggregation expression
 * that holds exactly for the documents the same filter returns on this
 * adapter (since 0.1.168) — `aggregate(f, x | w)` aggregates what
 * `aggregate(f ∧ w, x)` does:
 *
 * - `= v` / `$in` match an equal value or an array holding one; `= null`
 *   matches null, missing and an array holding null;
 * - `$ne` / `$nin` / `$not` are the plain negation (so they match null and
 *   missing values);
 * - `$gt` / `$gte` / `$lt` / `$lte` compare values of the operand's type class
 *   only (an array: any element); `$gt` / `$lt` against `null` match nothing;
 * - `$exists` is "holds a value"; `$regex` → `$regexMatch` over string values
 *   (MongoDB 4.2+);
 * - an empty `$or` / `$in` is false, an empty `$and` / `$nin` true.
 *
 * Collation: values compare byte-wise — like the filter of a grouped
 * aggregate on this adapter, whose pipeline runs without an operation-wide
 * collation. Never returns a bare boolean (a constant is `{ $literal: … }`).
 *
 * @since 0.1.168
 */
export function whereToExpr(where: FilterExpr): Document {
  return walkFilter(where, condVisitor) ?? TRUE_COND;
}
