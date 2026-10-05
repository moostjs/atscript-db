import { DbError, aggregateExpressionsNotSupported, type AtscriptExprNode } from "@atscript/db";

import type { SqlDialect } from "./dialect";

/** Why {@link renderArith} cannot render an expression. */
export type TArithFailure = "no-cast" | "non-finite";

/**
 * Renders a computed expression tree (`@db.compute` on a view, or a query-time
 * arithmetic `$select` entry) as SQL, in IEEE double on every dialect: each
 * literal is cast with {@link SqlDialect.castDouble}; `+ - *` render as
 * `(l op r)`, `/` as `(l / NULLIF(r, 0))` (division by zero is NULL), unary
 * minus as `(-x)` and `coalesce` as `COALESCE(…)`. `leaf` renders a field
 * reference as raw SQL, which is cast to double here — or, as `{ double }`,
 * SQL that already is a double (a nested computed column) and stays as is.
 *
 * The one renderer of both paths, so declared and query-time arithmetic
 * cannot diverge.
 *
 * @param fail - the error to throw for a failure (default `DbError`:
 *   `AGG_EXPR_NOT_SUPPORTED` without `castDouble`, `INVALID_QUERY` for a
 *   non-finite literal).
 * @since 0.1.148
 */
export function renderArith(
  dialect: SqlDialect,
  node: AtscriptExprNode,
  leaf: (field: string) => string | { double: string },
  fail: (reason: TArithFailure) => Error = defaultFailure,
): string {
  const cast = dialect.castDouble?.bind(dialect);
  if (!cast) throw fail("no-cast");
  const render = (e: AtscriptExprNode): string => {
    if (typeof e === "number") {
      if (!Number.isFinite(e)) throw fail("non-finite");
      return cast(String(e));
    }
    if ("field" in e) {
      const sql = leaf(e.field);
      return typeof sql === "string" ? cast(sql) : sql.double;
    }
    const args = e.args.map(render);
    switch (e.op) {
      case "neg": {
        return `(-${args[0]})`;
      }
      case "coalesce": {
        return `COALESCE(${args.join(", ")})`;
      }
      case "/": {
        return `(${args[0]} / NULLIF(${args[1]}, 0))`;
      }
      default: {
        return `(${args[0]} ${e.op} ${args[1]})`;
      }
    }
  };
  return render(node);
}

function defaultFailure(reason: TArithFailure): Error {
  return reason === "no-cast"
    ? aggregateExpressionsNotSupported()
    : new DbError("INVALID_QUERY", [
        { path: "$select", message: "Expression literal is not finite" },
      ]);
}

/** The error of a double overflow in aggregate arithmetic (`INVALID_QUERY`, `path` `$select`). */
export function arithOverflowError(): DbError {
  return new DbError("INVALID_QUERY", [{ path: "$select", message: "Arithmetic overflow" }]);
}
