import type {
  AtscriptDoc,
  SemanticInterfaceNode,
  SemanticNode,
  SemanticPropNode,
  SemanticQueryExprNode,
  SemanticQueryFieldRefNode,
  SemanticRefNode,
  SemanticStructureNode,
  TAnnotationTokens,
  Token,
  TMessages,
  TQueryScope,
} from "@atscript/core";
import { isInterface, isQueryComparison, isQueryLogical, isRef, isStructure } from "@atscript/core";

import { getAnnotationAlias } from "./annotation-utils";
import { DB_ENTITY_ANNOTATIONS } from "./derived-rules";

/** Options of {@link validateRefArgument}. */
export interface TRefArgumentOptions {
  /**
   * The declarations the argument may name — the same predicate its editor
   * `refFilter` completes with (`lsp-scopes`), so a diagnostic and the
   * completion list never disagree. A `@db.alias` declaration it rejects
   * gets the alias-specific message.
   * @since 0.1.141
   */
  accept?: (decl: SemanticNode) => boolean;
  /** What {@link accept} demands, for the diagnostic: `Type 'X' <expected>`. */
  expected?: string;
}

/** Whether a declaration node is a `@db.table` or a `@db.view` (managed or external). */
export function isDbSourceDecl(node: SemanticNode): boolean {
  return DB_ENTITY_ANNOTATIONS.some((name) => node.countAnnotations(name) > 0);
}

/** Whether a declaration node is a `@db.alias` type. @since 0.1.141 */
export function isAliasDecl(node: SemanticNode): boolean {
  return node.countAnnotations("db.alias") > 0;
}

/**
 * Validate a ref annotation argument against the document's type registry.
 * Returns diagnostic messages for unknown types or fields.
 */
export function validateRefArgument(
  token: Token,
  doc: AtscriptDoc,
  options?: TRefArgumentOptions,
): TMessages {
  const messages: TMessages = [];
  const text = token.text;
  const [typeName, ...chain] = text.split(".");

  const decl = doc.getDeclarationOwnerNode(typeName);
  if (!decl) {
    // If the type is imported but deps aren't loaded yet (e.g. during parse),
    // skip validation — it will be checked when deps are available.
    const regDef = doc.registry.definitions.get(typeName);
    if (regDef?.imported) {
      return messages;
    }
    messages.push({
      severity: 1,
      message: `Unknown type '${typeName}'.`,
      range: token.range,
    });
    return messages;
  }

  if (chain.length > 0) {
    const unwound = doc.unwindType(typeName, chain);
    if (!unwound) {
      messages.push({
        severity: 1,
        message: `Field '${chain.join(".")}' does not exist on type '${typeName}'.`,
        range: token.range,
      });
      return messages;
    }
  }

  if (options?.accept && decl.node && !options.accept(decl.node)) {
    messages.push({
      severity: 1,
      message: isAliasDecl(decl.node)
        ? `Type '${typeName}' is a @db.alias — a join alias cannot be used here, reference the aliased table or view.`
        : `Type '${typeName}' ${options.expected ?? "is not accepted here."}`,
      range: token.range,
    });
  }

  return messages;
}

/**
 * The declaration a view source name stands for: the named table / view, or
 * — for a `@db.alias` type — the aliased table / view. `undefined` when the
 * name does not resolve (unknown, or an import that is not loaded yet).
 * @since 0.1.141
 */
function resolveViewSourceDecl(
  name: string,
  doc: AtscriptDoc,
): { doc: AtscriptDoc; node: SemanticNode } | undefined {
  const decl = doc.getDeclarationOwnerNode(name);
  if (!decl?.node) {
    return undefined;
  }
  const aliasTarget = getAnnotationAlias(decl.node, "db.alias");
  if (aliasTarget !== undefined) {
    const target = decl.doc.getDeclarationOwnerNode(aliasTarget);
    return target?.node ? { doc: target.doc, node: target.node } : undefined;
  }
  return { doc: decl.doc, node: decl.node };
}

/**
 * VW9 — the dependency cycle a view closes, as the list of view names from
 * the view back to itself (`["A", "B", "A"]`), or `undefined`. Walks
 * `@db.view.for` / `@db.view.joins` of the referenced declarations across
 * documents; `@db.alias` sources resolve to their target.
 * @since 0.1.141
 */
export function findViewCycle(owner: SemanticNode, doc: AtscriptDoc): string[] | undefined {
  const start = owner.id;
  if (!start) {
    return undefined;
  }
  const visited = new Set<SemanticNode>();
  const walk = (node: SemanticNode, nodeDoc: AtscriptDoc, path: string[]): string[] | undefined => {
    for (const name of viewScopeTypes(node)) {
      const source = resolveViewSourceDecl(name, nodeDoc);
      if (!source) {
        continue;
      }
      if (source.node === owner) {
        return [...path, start];
      }
      if (visited.has(source.node)) {
        continue;
      }
      visited.add(source.node);
      const cycle = walk(source.node, source.doc, [...path, source.node.id ?? name]);
      if (cycle) {
        return cycle;
      }
    }
    return undefined;
  };
  return walk(owner, doc, [start]);
}

export interface TFKFieldMatch {
  name: string;
  prop: SemanticPropNode;
  chainRef: { type: string; field: string };
}

/**
 * Find all `@db.rel.FK` fields on a type that reference `targetTypeName`.
 * Resolves `extends` to include inherited fields.
 */
export function findFKFieldsPointingTo(
  doc: AtscriptDoc,
  iface: SemanticInterfaceNode | SemanticStructureNode,
  targetTypeName: string,
  alias?: string,
): TFKFieldMatch[] {
  const results: TFKFieldMatch[] = [];

  // Resolve extends if it's an interface with parents
  let struct: SemanticStructureNode | undefined;
  if (isInterface(iface) && iface.hasExtends) {
    const resolved = doc.resolveInterfaceExtends(iface);
    if (resolved && isStructure(resolved)) {
      struct = resolved;
    }
  }
  if (!struct) {
    struct = isStructure(iface)
      ? iface
      : isInterface(iface) && isStructure(iface.getDefinition())
        ? (iface.getDefinition() as SemanticStructureNode)
        : undefined;
  }
  if (!struct) {
    return results;
  }

  for (const [name, prop] of struct.props) {
    if (prop.countAnnotations("db.rel.FK") === 0) {
      continue;
    }

    const def = prop.getDefinition();
    if (!def || !isRef(def)) {
      continue;
    }

    const ref = def as SemanticRefNode;
    if (!ref.hasChain) {
      continue;
    }

    const refTypeName = ref.id!;
    const refField = ref.chain.map((c) => c.text).join(".");

    if (refTypeName !== targetTypeName) {
      continue;
    }

    // If alias filter provided, check the FK alias annotation argument
    if (alias !== undefined) {
      const fkAnnotations = prop.annotations?.filter((a) => a.name === "db.rel.FK");
      const hasMatchingAlias = fkAnnotations?.some(
        (a) => a.args.length > 0 && a.args[0].text === alias,
      );
      if (!hasMatchingAlias) {
        continue;
      }
    }

    results.push({
      name,
      prop,
      chainRef: { type: refTypeName, field: refField },
    });
  }

  return results;
}

const viewAnnotationNames = [
  "db.view",
  "db.view.for",
  "db.view.joins",
  "db.view.filter",
  "db.view.materialized",
];

/** The `@db.view.joins` annotations of a view interface, in declaration order. */
export function viewJoins(owner: SemanticNode): TAnnotationTokens[] {
  return owner.annotations?.filter((a) => a.name === "db.view.joins") ?? [];
}

/** The target type names of `@db.view.joins` annotations. */
export function joinTargets(joins: readonly TAnnotationTokens[]): string[] {
  return joins.map((a) => a.args[0]?.text).filter((t): t is string => !!t);
}

/**
 * The targets of the `@db.view.joins` declared before `join` among the
 * view's `joins` ({@link viewJoins}) — what a chained join condition may
 * reference besides its target and the entry.
 * @since 0.1.141
 */
export function earlierJoinTargets(
  joins: readonly TAnnotationTokens[],
  join: TAnnotationTokens,
): string[] {
  const position = joins.indexOf(join);
  return joinTargets(position === -1 ? [] : joins.slice(0, position));
}

/**
 * The type names a view predicate (`@db.view.filter`, a conditional
 * `@db.agg.*`) may reference: the `@db.view.for` entry table, then every
 * `@db.view.joins` target.
 */
export function viewScopeTypes(owner: SemanticNode): string[] {
  const entry = getAnnotationAlias(owner, "db.view.for");
  const targets = joinTargets(viewJoins(owner));
  return entry ? [entry, ...targets] : targets;
}

/**
 * Check if a node has any @db.view.* annotation.
 */
export function hasAnyViewAnnotation(node: SemanticNode): boolean {
  return viewAnnotationNames.some((name) => node.countAnnotations(name) > 0);
}

/**
 * Validate that all field refs in a query expression are within `scope` —
 * the same {@link TQueryScope} the editor completes (`lsp-scopes`):
 * qualified refs must name one of `scope.allowedTypes`; an unqualified ref
 * (a dotted path included) must be a field of `scope.unqualifiedTarget`, or
 * is rejected outright when that is `null`.
 *
 * @param queryToken - The query arg token (must have .queryNode)
 * @param scope - The scope of the argument
 * @param doc - The document for type lookups
 * @param scopeHint - Replaces the default "expected 'A' or 'B'" tail of the out-of-scope message
 */
export function validateQueryScope(
  queryToken: Token,
  scope: TQueryScope,
  doc: AtscriptDoc,
  scopeHint?: string,
): TMessages {
  const errors: TMessages = [];
  const queryNode = queryToken.queryNode;
  if (!queryNode) {
    return errors;
  }
  const { allowedTypes, unqualifiedTarget } = scope;

  forEachFieldRef(queryNode.expression, (ref) => {
    if (ref.typeRef) {
      // Qualified ref: check type is in scope
      const typeName = ref.typeRef.text;
      if (!allowedTypes.includes(typeName)) {
        errors.push({
          message: `Query references '${typeName}' which is not in scope — ${scopeHint ?? `expected ${allowedTypes.map((t) => `'${t}'`).join(" or ")}`}`,
          severity: 1,
          range: ref.typeRef.range,
        });
      }
    } else if (unqualifiedTarget === null) {
      // Unqualified refs not allowed in this context
      errors.push({
        message: `Unqualified field reference '${ref.fieldRef.text}' — use qualified form (e.g., Type.${ref.fieldRef.text})`,
        severity: 1,
        range: ref.fieldRef.range,
      });
    } else {
      // Validate an unqualified ref (a dotted path included) against the
      // target type — a type that is not an object is not checked here
      const targetDef = doc.unwindType(unqualifiedTarget)?.def;
      if (
        targetDef &&
        (isInterface(targetDef) || isStructure(targetDef)) &&
        !doc.unwindType(unqualifiedTarget, ref.fieldRef.text.split("."))
      ) {
        errors.push({
          message: `Field '${ref.fieldRef.text}' does not exist on '${unqualifiedTarget}'`,
          severity: 1,
          range: ref.fieldRef.range,
        });
      }
    }
  });

  return errors;
}

/**
 * Calls `fn` for every field reference of a query expression — both operands
 * of a field-to-field comparison included.
 * @since 0.1.141
 */
export function forEachFieldRef(
  expr: SemanticQueryExprNode,
  fn: (ref: SemanticQueryFieldRefNode) => void,
): void {
  if (isQueryLogical(expr)) {
    for (const operand of expr.operands) {
      forEachFieldRef(operand, fn);
    }
  } else if (isQueryComparison(expr)) {
    fn(expr.left);
    // right can also be a field ref (ref-to-ref comparison)
    if (expr.right && "fieldRef" in expr.right) {
      fn(expr.right as SemanticQueryFieldRefNode);
    }
  }
}
