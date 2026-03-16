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

/** A single join in a view query plan. */
export interface TViewJoin {
  targetType: () => TAtscriptAnnotatedType;
  targetTable: string;
  condition: AtscriptQueryNode;
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
  if (comp.right && typeof comp.right === "object" && "field" in (comp.right as object)) {
    const rightField = resolveField(comp.right as AtscriptQueryFieldRef);
    return { [leftField]: { [comp.op]: { $field: rightField } } } as FilterExpr;
  }

  // Value comparison (scalar, array, or unary like $exists)
  if (comp.op === "$exists") {
    return { [leftField]: { $exists: true } } as FilterExpr;
  }

  return { [leftField]: { [comp.op]: comp.right } } as FilterExpr;
}
