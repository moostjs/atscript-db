import type {
  TAtscriptAnnotatedType,
  AtscriptExprNode,
  AtscriptQueryNode,
  AtscriptQueryFieldRef,
} from "@atscript/typescript/utils";
import type { FilterExpr } from "@uniqu/core";

export type {
  AtscriptQueryNode,
  AtscriptQueryFieldRef,
  AtscriptQueryComparison,
  AtscriptRef,
  AtscriptExprNode,
  AtscriptOrderItem,
} from "@atscript/typescript/utils";

/**
 * `true` when a query-tree operand is a field reference (`{ field, type? }`)
 * rather than a literal — e.g. the right side of a field-to-field comparison.
 * @since 0.1.136
 */
export function isFieldRef(value: unknown): value is AtscriptQueryFieldRef {
  return value !== null && typeof value === "object" && "field" in value;
}

/** A single join in a view query plan. */
export interface TViewJoin {
  targetType: () => TAtscriptAnnotatedType;
  /** Physical table (or view) joined. */
  targetTable: string;
  /**
   * The name the join is addressed by in conditions, filters and column
   * mappings: {@link targetTable} for a plain target, the alias's type name
   * for a `@db.alias` target (`JOIN "employees" AS "Manager"`).
   * @since 0.1.141
   */
  scope: string;
  condition: AtscriptQueryNode;
  /**
   * `inner` (default) drops entry rows without a match; `left` keeps them
   * with the target's columns as NULL. Joins apply in declaration order.
   * @since 0.1.136
   */
  kind: "inner" | "left";
  /**
   * Set for a first-row join (the `@db.view.joins` 4th argument): of the
   * target rows matching {@link condition} only the first by `order` joins.
   * `order` refs are qualified with the target (`ref.type`), the target's
   * primary key appended as the final ascending key unless already a key;
   * `key` is that primary key's logical path — the anchor of the join's
   * correlated subquery. NULL is the smallest value (first in `asc`).
   * @since 0.1.147
   */
  first?: {
    order: Array<{ ref: AtscriptQueryFieldRef; desc: boolean }>;
    key: string;
  };
}

/** Resolved view query plan produced by AtscriptDbView. */
export interface TViewPlan {
  entryType: () => TAtscriptAnnotatedType;
  entryTable: string;
  joins: TViewJoin[];
  filter?: AtscriptQueryNode;
  having?: AtscriptQueryNode;
  materialized: boolean;
}

/**
 * Translates a JS-emitted query tree into a FilterExpr.
 * Resolves field references (type + field path) to physical column names
 * via the provided resolver function.
 */
export function translateQueryTree(
  node: AtscriptQueryNode,
  resolveField: (ref: AtscriptQueryFieldRef) => string,
): FilterExpr {
  if ("$and" in node) {
    return {
      $and: (node as { $and: AtscriptQueryNode[] }).$and.map((n) =>
        translateQueryTree(n, resolveField),
      ),
    } as FilterExpr;
  }
  if ("$or" in node) {
    return {
      $or: (node as { $or: AtscriptQueryNode[] }).$or.map((n) =>
        translateQueryTree(n, resolveField),
      ),
    } as FilterExpr;
  }
  if ("$not" in node) {
    return {
      $not: translateQueryTree((node as { $not: AtscriptQueryNode }).$not, resolveField),
    } as FilterExpr;
  }

  // Comparison node
  const comp = node as { left: AtscriptQueryFieldRef; op: string; right?: unknown };
  const leftField = resolveField(comp.left);

  // Field-to-field comparison
  if (isFieldRef(comp.right)) {
    const rightField = resolveField(comp.right);
    return { [leftField]: { [comp.op]: { $field: rightField } } } as FilterExpr;
  }

  // Value comparison (scalar, array, or unary like $exists — `not exists`
  // compiles to `right: false`)
  if (comp.op === "$exists") {
    return { [leftField]: { $exists: comp.right !== false } } as FilterExpr;
  }

  return { [leftField]: { [comp.op]: comp.right } } as FilterExpr;
}

/**
 * Calls `leaf` with the field path of every field-reference leaf of a
 * computed-column expression (`@db.compute`), in source order — leaves name
 * the view's own fields.
 * @since 0.1.147
 */
export function walkViewExpr(expr: AtscriptExprNode, leaf: (path: string) => void): void {
  if (typeof expr === "number") return;
  if ("field" in expr) {
    leaf(expr.field);
    return;
  }
  for (const arg of expr.args) {
    walkViewExpr(arg, leaf);
  }
}

/**
 * Whether a computed-column expression may yield NULL: a `/` (division by
 * zero is NULL), a leaf for which `nullableLeaf` holds, or an operation over
 * a nullable operand — `coalesce` only when every argument is nullable.
 * @since 0.1.147
 */
export function viewExprNullable(
  expr: AtscriptExprNode,
  nullableLeaf: (path: string) => boolean,
): boolean {
  if (typeof expr === "number") return false;
  if ("field" in expr) return nullableLeaf(expr.field);
  if (expr.op === "/") return true;
  if (expr.op === "coalesce") return expr.args.every((a) => viewExprNullable(a, nullableLeaf));
  return expr.args.some((a) => viewExprNullable(a, nullableLeaf));
}

/**
 * The `@db.compute` expression of a view field, if any.
 * @since 0.1.147
 */
export function computeOf(
  fieldType: TAtscriptAnnotatedType | undefined,
): AtscriptExprNode | undefined {
  return fieldType?.metadata.get("db.compute");
}

/**
 * The transitive non-computed operands of the `@db.compute` field `field` of
 * `viewType`: its leaves, a computed leaf replaced by its own operands (the
 * computed fields passed through are pushed to `via` when given).
 * `undefined` when `field` is not computed. Cycles are not followed (they
 * are rejected where the view's columns are built).
 * @since 0.1.147
 */
export function computedOperands(
  viewType: TAtscriptAnnotatedType,
  field: string,
  via?: string[],
): string[] | undefined {
  const props = viewType.type.kind === "object" ? viewType.type.props : undefined;
  const exprOf = (name: string) => computeOf(props?.get(name));
  const root = exprOf(field);
  if (root === undefined) return undefined;
  const out = new Set<string>();
  const seen = new Set<string>([field]);
  const visit = (expr: AtscriptExprNode) =>
    walkViewExpr(expr, (path) => {
      const nested = exprOf(path);
      if (nested === undefined) {
        out.add(path);
      } else if (!seen.has(path)) {
        seen.add(path);
        via?.push(path);
        visit(nested);
      }
    });
  visit(root);
  return [...out];
}
