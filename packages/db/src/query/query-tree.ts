import type {
  TAtscriptAnnotatedType,
  AtscriptQueryNode,
  AtscriptQueryFieldRef,
} from "@atscript/typescript/utils";
import type { FilterExpr } from "@uniqu/core";

export type {
  AtscriptQueryNode,
  AtscriptQueryFieldRef,
  AtscriptQueryComparison,
  AtscriptRef,
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
  targetTable: string;
  condition: AtscriptQueryNode;
  /**
   * `inner` (default) drops entry rows without a match; `left` keeps them
   * with the target's columns as NULL. Joins apply in declaration order.
   * @since 0.1.136
   */
  kind: "inner" | "left";
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
