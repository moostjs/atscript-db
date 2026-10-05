import { AnnotationSpec, isPrimitive, isRef } from "@atscript/core";
import type {
  AtscriptDoc,
  SemanticExprItemNode,
  SemanticNode,
  TAnnotationsTree,
  TMessages,
  Token,
} from "@atscript/core";

import {
  getDbTableOwner,
  primitiveBaseType,
  validateExclusiveWith,
} from "../../shared/annotation-utils";
import { AGG_ANNOTATIONS } from "../../query/aggregate-fns";
import { numericTypeProblem } from "../../shared/numeric-operand";
import { validateQueryScope } from "../../shared/validation-utils";
import { viewProps } from "../../shared/view-validation";
import { fieldScopes, viewHavingScope } from "../lsp-scopes";

/** What a `@db.compute` field cannot also carry (VC1). */
const EXCLUSIVE_WITH = [...AGG_ANNOTATIONS, "db.json", "db.ignore"].map((key) => ({ key }));

/** The `@db.compute` expression token of a prop, if any. */
function computeArg(prop: SemanticNode | undefined): Token | undefined {
  return prop?.annotations?.find((a) => a.name === "db.compute")?.args[0];
}

/**
 * Whether a prop is typed exactly `number` (a plain primitive ref — no chain
 * ref, no `number.*` extension).
 */
function isPlainNumber(prop: SemanticNode, doc: AtscriptDoc): boolean {
  const def = prop.getDefinition();
  if (!def || !isRef(def) || def.hasChain || def.id !== "number") return false;
  return isPrimitive(doc.unwindType("number")?.def);
}

/**
 * Why an operand prop cannot be computed with, or `undefined` when it can:
 * its resolved type must be a `number` primitive — not `decimal`, not a
 * timestamp — and it must have storage (no `@db.ignore`).
 */
function operandProblem(prop: SemanticNode, doc: AtscriptDoc): string | undefined {
  if (prop.countAnnotations("db.ignore") > 0) return "is @db.ignore'd";
  if (computeArg(prop)) return undefined; // typed `number` by its own @db.compute
  const def = prop.getDefinition();
  const leaf = def && isRef(def) ? doc.unwindType(def.id!, def.chain)?.def : def;
  const base = primitiveBaseType(leaf);
  if (base === undefined) return undefined; // unresolved — sync reports it
  return numericTypeProblem({ base, tags: isPrimitive(leaf) ? leaf.tags : undefined });
}

/** VC6 — whether an expression may be NULL (`/` by zero, an optional operand). */
function exprNullable(
  node: SemanticExprItemNode,
  props: ReadonlyMap<string, SemanticNode>,
): boolean {
  if ("value" in node) return false;
  if ("left" in node) {
    return node.op === "/" || exprNullable(node.left, props) || exprNullable(node.right, props);
  }
  if ("operand" in node) return exprNullable(node.operand, props);
  if ("args" in node) return node.args.every((a) => exprNullable(a, props));
  return props.get(node.fieldRef.text)?.has("optional") ?? false;
}

/**
 * VC4 — the first `@db.compute` cycle through `start`, as field names
 * (`rank → priority → rank`), or `undefined`.
 */
function findComputeCycle(
  start: string,
  props: ReadonlyMap<string, SemanticNode>,
): string[] | undefined {
  const path: string[] = [];
  const done = new Set<string>();
  const visit = (name: string): string[] | undefined => {
    const at = path.indexOf(name);
    if (at !== -1) return name === start ? [...path.slice(at), name] : undefined;
    if (done.has(name)) return undefined;
    const refs = computeArg(props.get(name))?.exprNode?.fieldRefs() ?? [];
    path.push(name);
    for (const ref of refs) {
      if (ref.typeRef) continue;
      const cycle = visit(ref.fieldRef.text);
      if (cycle) return cycle;
    }
    path.pop();
    done.add(name);
    return undefined;
  };
  return visit(start);
}

function validateCompute(token: Token, args: Token[], doc: AtscriptDoc): TMessages {
  const errors: TMessages = [];
  const prop = token.parentNode!;
  const field = prop.id ?? "field";
  const view = getDbTableOwner(token);
  const error = (message: string, range = token.range) =>
    errors.push({ message, severity: 1, range });

  // VC1: a field of a managed view, typed `number`, not an aggregate / JSON / ignored field
  if (!view || view.countAnnotations("db.view.for") === 0) {
    error("@db.compute is only valid on a field of a @db.view.for view");
    return errors;
  }
  errors.push(...validateExclusiveWith(token, "@db.compute", EXCLUSIVE_WITH));
  if (!isPlainNumber(prop, doc)) {
    error(`Field "${field}" has a @db.compute and must be typed \`number\``);
  }

  const expr = args[0]?.exprNode;
  if (!expr) return errors;
  const refs = expr.fieldRefs();
  const props = viewProps(view) ?? new Map<string, SemanticNode>();

  // VC5: at least one field
  if (refs.length === 0) {
    error(
      "@db.compute needs at least one view field — a constant column is not supported",
      args[0].range,
    );
  }

  // VC2: unqualified fields of this view only — the scope the editor completes
  const scope = viewHavingScope(view);
  if (scope) {
    errors.push(
      ...validateQueryScope(
        args[0],
        scope,
        doc,
        "@db.compute references the view's own fields — declare it on the view first (`field: Type.field`)",
      ),
    );
  }

  // VC3: every operand is a number
  for (const ref of refs) {
    if (ref.typeRef) continue;
    const operand = props.get(ref.fieldRef.text);
    const why = operand && operandProblem(operand, doc);
    if (why) {
      error(
        `@db.compute operand '${ref.fieldRef.text}' ${why} — operands must be number fields`,
        ref.fieldRef.range,
      );
    }
  }

  // VC4: no cycle among computed fields
  if (prop.id) {
    const cycle = findComputeCycle(prop.id, props);
    if (cycle) {
      error(`@db.compute of "${field}" depends on itself: ${cycle.join(" → ")}`, args[0].range);
    }
  }

  // VC6: a nullable expression needs an optional field
  if (!prop.has("optional") && exprNullable(expr.expression, props)) {
    error(
      `Field "${field}" has a @db.compute that may be NULL and must be optional (${field}?: …) — ` +
        "it is NULL when an operand is NULL or a divisor is 0",
    );
  }
  return errors;
}

export const dbComputeAnnotations: TAnnotationsTree = {
  compute: new AnnotationSpec({
    description:
      "Declares a **computed view column** (since 0.1.147): closed arithmetic over the view's own " +
      "fields — dimensions, aggregates, first-row-join fields and other computed fields — " +
      "evaluated by the database, so the column sorts, filters and pages like any other.\n\n" +
      "Grammar: `+ - * /`, unary `-`, parentheses, numeric literals, `coalesce(a, b, …)`. " +
      "Every value is a double (`7 / 2 = 3.5`); a NULL operand yields NULL; division by zero " +
      "yields NULL — so an expression with `/` or an optional operand needs an optional field.\n\n" +
      "**Example:**\n" +
      "```atscript\n" +
      "@db.agg.count 'id', `Issue.status = 'open'`\n" +
      "openCount: Issue.id\n\n" +
      "@db.compute `openCount * 10 + coalesce(oldestSeverity, 0)`\n" +
      "rank: number\n" +
      "```\n",
    nodeType: ["prop"],
    passedWhenReferred: false,
    argument: {
      name: "expression",
      type: "expr",
      description:
        "Arithmetic over the view's own fields (unqualified): `+ - * /`, unary `-`, parentheses, " +
        "numbers, `coalesce(a, b, …)`.",
      fieldScope: fieldScopes.compute,
    },
    validate: validateCompute,
  }),
};
