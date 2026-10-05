import {
  ARITH_MAX_NODES,
  isAggregateExpr,
  isAggregateOfExpr,
  isBucketExpr,
  isSelectArithExpr,
  resolveAlias,
  type AggregateQuery,
  type ArithExpr,
  type ResolvedRowOrderKey,
  type ResolvedSelectExpr,
} from "@uniqu/core";
import type { AtscriptExprNode } from "@atscript/typescript/utils";

import { DbError } from "../db-error";
import { isFirstLast } from "./aggregate-fns";
import { numericTypeProblem } from "../shared/numeric-operand";
import type { TableMetadata } from "../table/table-metadata";
import type { TDbFieldMeta } from "../types";
import { isJsonValueField } from "./buckets";

/** Most nodes a group-level expression may have once the aliases it names are inlined (SQL repeats them). */
const EXPANDED_MAX_NODES = 4 * ARITH_MAX_NODES;

/** Most expanded nodes ALL the expression entries of one query may have together. */
export const QUERY_EXPANDED_MAX_NODES = 1024;

/**
 * Why a field cannot be an arithmetic operand, or `undefined` when it can: it
 * must be a `number` (not a decimal — those are exact, an expression is IEEE
 * double — and not a timestamp-tagged number) with plain column storage. The
 * runtime twin of `@db.compute`'s operand rule, so declared and query-time
 * arithmetic accept the same fields.
 *
 * @since 0.1.148
 */
export function numericOperandProblem(fd: TDbFieldMeta): string | undefined {
  if (fd.encrypted) return "is encrypted";
  if (isJsonValueField(fd)) return "is not a scalar number";
  return numericTypeProblem({
    base: fd.designType,
    tags: (fd.type?.type as { tags?: ReadonlySet<string> } | undefined)?.tags,
  });
}

/**
 * Converts uniqu's JSON arithmetic into the `@db.compute` expression tree
 * the SQL / MongoDB / memory renderers consume: a name becomes a
 * `{ field }` leaf, unary `-` becomes `neg`. `rename` maps each name (the
 * mapper makes row-level names physical; group-level names stay aliases).
 *
 * @since 0.1.148
 */
export function arithToExprNode(
  expr: ArithExpr,
  rename: (name: string) => string = (n) => n,
): AtscriptExprNode {
  if (typeof expr === "number") return expr;
  if (typeof expr === "string") return { field: rename(expr) };
  const args = expr.$args.map((a) => arithToExprNode(a, rename));
  if (expr.$op === "-" && args.length === 1) return { op: "neg", args: [args[0]] };
  if (expr.$op === "coalesce") return { op: "coalesce", args };
  return { op: expr.$op, args: [args[0], args[1]] } as AtscriptExprNode;
}

/**
 * The field paths a `$select` entry reads from the table's rows: a plain
 * field, an aggregate's `$field` (`*` excluded), a row-level expression's
 * names, a calendar bucket's source. A group-level expression contributes
 * none (its names are aliases).
 */
/** Most nodes {@link entryFields} visits of one expression — the shape rules reject anything larger later. */
const NAMES_SCAN_MAX_NODES = 4 * ARITH_MAX_NODES;

/**
 * The names an expression reads, found iteratively and bounded: this runs on
 * a raw, not yet validated expression (a 10k-deep chain must not overflow the
 * stack — `normalizeComputedSelect` rejects it afterwards).
 */
function boundedArithNames(expr: unknown): string[] {
  const out = new Set<string>();
  const stack: unknown[] = [expr];
  for (let visited = 0; stack.length > 0 && visited < NAMES_SCAN_MAX_NODES; visited++) {
    const e = stack.pop();
    if (typeof e === "string") out.add(e);
    else if (e && typeof e === "object" && Array.isArray((e as { $args?: unknown }).$args)) {
      stack.push(...(e as { $args: unknown[] }).$args.toReversed());
    }
  }
  return [...out];
}

export function entryFields(item: unknown): string[] {
  if (typeof item === "string") return [item];
  if (isAggregateExpr(item)) return item.$field === "*" ? [] : [item.$field];
  if (isAggregateOfExpr(item)) return boundedArithNames(item.$expr);
  if (isBucketExpr(item)) return [item.$field];
  return [];
}

/** Keys of a `$rowOrder` control (the raw object), or `[]`. */
export function rowOrderKeys(rowOrder: unknown): string[] {
  return rowOrder && typeof rowOrder === "object" ? Object.keys(rowOrder) : [];
}

/**
 * Schema-dependent rules of query-time arithmetic and `first` / `last`, after
 * the shape normalizer and the path guard:
 *
 * - every row-level operand and every group-level operand that is a `$groupBy`
 *   field is a numeric field ({@link numericOperandProblem});
 * - every group-level operand that is a `$select` alias is numeric: counts and
 *   expressions always, `sum` / `avg` / `min` / `max` / `first` / `last` when
 *   their `$field` is;
 * - a `first` / `last` field is a scalar (no JSON value or array);
 * - in a strict (dimension / measure) table row-level operands are measures and
 *   `$rowOrder` keys are dimensions or measures (a `first` / `last` field
 *   follows the aggregate rule in `aggregate()`);
 * - an operand or `first` / `last` field tagged with a quantity ref needs that
 *   ref in `$groupBy`;
 * - a group-level expression stays within {@link EXPANDED_MAX_NODES} once the
 *   aliases it names are inlined (SQL repeats them at every use), and all the
 *   expression entries of the query together within {@link QUERY_EXPANDED_MAX_NODES}.
 *
 * Unknown fields are the path guard's, so they are skipped here.
 *
 * @throws DbError `INVALID_QUERY` with every issue.
 * @since 0.1.148
 */
export function checkAggregateExprs(
  meta: TableMetadata,
  query: AggregateQuery,
  exprs: readonly ResolvedSelectExpr[],
  rowOrder: readonly ResolvedRowOrderKey[] | undefined,
): void {
  const select = query.controls.$select;
  if (!Array.isArray(select)) return;
  const issues: Array<{ path: string; message: string }> = [];
  const fdOf = (name: string) => meta.descriptorByPath.get(name);
  const numericField = (name: string): boolean => {
    const fd = fdOf(name);
    return fd === undefined || numericOperandProblem(fd) === undefined;
  };
  const operandIssue = (name: string) => {
    if (!numericField(name)) {
      issues.push({
        path: "$select",
        message: `Field "${name}" is not numeric — arithmetic needs a number field (not decimal, timestamp or text)`,
      });
    }
  };

  // alias → whether the entry is a number (QX2)
  const numericAlias = new Map<string, boolean>();
  for (const item of select as unknown[]) {
    if (isAggregateExpr(item)) {
      const counts = item.$fn === "count" || item.$fn === "countDistinct";
      numericAlias.set(resolveAlias(item), counts || numericField(item.$field));
    } else if (isAggregateOfExpr(item) || isSelectArithExpr(item)) {
      numericAlias.set(item.$as, true);
    }
  }

  const strict = meta.dimensions.length > 0 || meta.measures.length > 0;
  const groupBy = new Set(query.controls.$groupBy);
  const refGroup = (label: string, field: string) => {
    const ref = meta.quantityRefByField.get(field);
    if (ref && !groupBy.has(ref)) {
      issues.push({
        path: "$select",
        message: `${label} requires "${ref}" in $groupBy — quantity-ref-tagged fields must be grouped by their dimension`,
      });
    }
  };

  for (const e of exprs) {
    if (e.level === "row") {
      for (const name of e.names) {
        operandIssue(name);
        if (strict && fdOf(name) && !meta.measures.includes(name)) {
          issues.push({
            path: "$select",
            message: `Expression operand "${name}" is not a measure`,
          });
        }
        refGroup(`Expression "${e.alias}"`, name);
      }
      continue;
    }
    for (const name of e.names) {
      const isAlias = numericAlias.has(name);
      if (isAlias) {
        if (numericAlias.get(name) === false) {
          issues.push({
            path: "$select",
            message: `"${name}" is not numeric and cannot be used in an expression`,
          });
        }
      } else operandIssue(name);
    }
  }

  for (const item of select as unknown[]) {
    if (!isFirstLast(item)) continue;
    const fd = fdOf(item.$field);
    if (fd && (isJsonValueField(fd) || fd.designType === "array")) {
      issues.push({
        path: "$select",
        message: `${item.$fn}("${item.$field}") needs a scalar field — not a JSON value or array`,
      });
    }
  }
  for (const key of rowOrder ?? []) {
    if (
      strict &&
      fdOf(key.field) &&
      !meta.dimensions.includes(key.field) &&
      !meta.measures.includes(key.field)
    ) {
      issues.push({
        path: "$rowOrder",
        message: `$rowOrder field "${key.field}" is not a dimension or measure`,
      });
    }
  }

  // Expanded size: an alias used twice doubles what it stands for, so a short
  // chain (`x = a+a`, `y = x*x`, …) blows up exponentially in SQL.
  const expanded = new Map<string, number>();
  const countNodes = (expr: ArithExpr): number =>
    typeof expr === "number"
      ? 1
      : typeof expr === "string"
        ? (expanded.get(expr) ?? 1)
        : 1 + expr.$args.reduce<number>((sum, arg) => sum + countNodes(arg), 0);
  let total = 0;
  const issuesBeforeSize = issues.length;
  for (const e of exprs) {
    const size = countNodes(e.expr);
    expanded.set(e.alias, size);
    total += size;
    if (size > EXPANDED_MAX_NODES) {
      issues.push({
        path: "$select",
        message: `Expression "${e.alias}" is too large once its aliases are expanded (more than ${EXPANDED_MAX_NODES} nodes)`,
      });
    }
  }

  // (a per-entry issue already says the query is too large)
  if (total > QUERY_EXPANDED_MAX_NODES && issues.length === issuesBeforeSize) {
    issues.push({
      path: "$select",
      message: `The expressions of this query are too large together (more than ${QUERY_EXPANDED_MAX_NODES} nodes once their aliases are expanded)`,
    });
  }

  if (issues.length) throw new DbError("INVALID_QUERY", issues);
}
