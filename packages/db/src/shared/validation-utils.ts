import type {
  AtscriptDoc,
  SemanticInterfaceNode,
  SemanticNode,
  SemanticPropNode,
  SemanticQueryExprNode,
  SemanticQueryFieldRefNode,
  SemanticRefNode,
  SemanticStructureNode,
  Token,
  TMessages,
} from "@atscript/core";
import { isInterface, isQueryComparison, isQueryLogical, isRef, isStructure } from "@atscript/core";

/**
 * Validate a ref annotation argument against the document's type registry.
 * Returns diagnostic messages for unknown types or fields.
 */
export function validateRefArgument(
  token: Token,
  doc: AtscriptDoc,
  options?: { requireDbTable?: boolean },
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

  if (options?.requireDbTable && decl.node) {
    const hasDbTable = decl.node.countAnnotations("db.table") > 0;
    if (!hasDbTable) {
      messages.push({
        severity: 1,
        message: `Type '${typeName}' must have @db.table annotation.`,
        range: token.range,
      });
    }
  }

  return messages;
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

/**
 * Check if a node has any @db.view.* annotation.
 */
export function hasAnyViewAnnotation(node: SemanticNode): boolean {
  return viewAnnotationNames.some((name) => node.countAnnotations(name) > 0);
}

/**
 * Validate that all type refs in a query expression are within the allowed scope.
 *
 * @param queryToken - The query arg token (must have .queryNode)
 * @param allowedTypes - Type names allowed as qualified refs
 * @param unqualifiedTarget - Type name for resolving unqualified refs, or null to disallow them
 * @param doc - The document for type lookups
 */
export function validateQueryScope(
  queryToken: Token,
  allowedTypes: string[],
  unqualifiedTarget: string | null,
  doc: AtscriptDoc,
): TMessages {
  const errors: TMessages = [];
  const queryNode = queryToken.queryNode;
  if (!queryNode) {
    return errors;
  }

  function walkFieldRef(ref: SemanticQueryFieldRefNode): void {
    if (ref.typeRef) {
      // Qualified ref: check type is in scope
      const typeName = ref.typeRef.text;
      if (!allowedTypes.includes(typeName)) {
        errors.push({
          message: `Query references '${typeName}' which is not in scope — expected ${allowedTypes.map((t) => `'${t}'`).join(" or ")}`,
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
      // Validate unqualified ref against the target type
      const unwound = doc.unwindType(unqualifiedTarget);
      if (unwound) {
        const targetDef = unwound.def;
        if (isInterface(targetDef) || isStructure(targetDef)) {
          const struct = isInterface(targetDef)
            ? (targetDef.getDefinition() as SemanticStructureNode | undefined)
            : targetDef;
          if (struct && isStructure(struct) && !struct.props.has(ref.fieldRef.text)) {
            errors.push({
              message: `Field '${ref.fieldRef.text}' does not exist on '${unqualifiedTarget}'`,
              severity: 1,
              range: ref.fieldRef.range,
            });
          }
        }
      }
    }
  }

  function walkExpr(expr: SemanticQueryExprNode): void {
    if (isQueryLogical(expr)) {
      for (const operand of expr.operands) {
        walkExpr(operand);
      }
    } else if (isQueryComparison(expr)) {
      walkFieldRef(expr.left);
      // right can also be a field ref (ref-to-ref comparison)
      if (expr.right && "fieldRef" in expr.right) {
        walkFieldRef(expr.right as SemanticQueryFieldRefNode);
      }
    }
  }

  walkExpr(queryNode.expression);
  return errors;
}
