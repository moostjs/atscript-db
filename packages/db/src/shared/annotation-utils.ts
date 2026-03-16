import {
  AnnotationSpec,
  type AtscriptDoc,
  isArray,
  isInterface,
  isPrimitive,
  isRef,
  isStructure,
  type SemanticNode,
  type SemanticStructureNode,
  type Token,
  type TMessages,
} from "@atscript/core";

/**
 * Traverse from annotation token → prop → structure → interface
 * to check if the parent interface has @db.table.
 */
export function getDbTableOwner(token: Token): SemanticNode | undefined {
  const field = token.parentNode!;
  const struct = field.ownerNode;
  if (!struct || !isStructure(struct)) {
    return undefined;
  }
  const iface = struct.ownerNode;
  return iface && isInterface(iface) ? iface : struct;
}

/**
 * Get the parent structure node from an annotation token.
 */
export function getParentStruct(token: Token): SemanticStructureNode | undefined {
  const field = token.parentNode!;
  const struct = field.ownerNode;
  return struct && isStructure(struct) ? (struct as SemanticStructureNode) : undefined;
}

/**
 * Get the parent interface name (for error messages and cross-type resolution).
 */
export function getParentTypeName(token: Token): string | undefined {
  const struct = getParentStruct(token);
  if (!struct) {
    return undefined;
  }
  const iface = struct.ownerNode;
  return iface && isInterface(iface) ? iface.id! : struct.id;
}

/**
 * Validate that an annotation is on a field with the expected base type.
 */
export function validateFieldBaseType(
  token: Token,
  doc: AtscriptDoc,
  annotationName: string,
  expectedType: string | string[],
): TMessages {
  const errors = [] as TMessages;
  const field = token.parentNode!;
  const definition = field.getDefinition();
  if (!definition || !isRef(definition)) {
    return errors;
  }
  const unwound = doc.unwindType(definition.id!, definition.chain);
  if (!unwound || !isPrimitive(unwound.def)) {
    return errors;
  }
  const ct = unwound.def.config.type;
  const baseType = typeof ct === "object" ? (ct.kind === "final" ? ct.value : ct.kind) : ct;
  const allowed = Array.isArray(expectedType) ? expectedType : [expectedType];
  if (!allowed.includes(baseType as string)) {
    errors.push({
      message: `${annotationName} is not compatible with type "${baseType}" — requires ${allowed.join(" or ")}`,
      severity: 1,
      range: token.range,
    });
  }
  return errors;
}

/**
 * Extract target type name from a navigational field definition.
 * Unwraps arrays (e.g., `Post[]` → `Post`).
 */
export function getNavTargetTypeName(field: SemanticNode): string | undefined {
  let def = field.getDefinition();
  if (isArray(def)) {
    def = def?.getDefinition();
  }
  if (isRef(def)) {
    return def.id!;
  }
  return undefined;
}

/**
 * Get the alias argument from an annotation on a field.
 */
export function getAnnotationAlias(prop: SemanticNode, annotationName: string): string | undefined {
  const annotations = prop.annotations?.filter((a) => a.name === annotationName);
  if (!annotations || annotations.length === 0) {
    return undefined;
  }
  return annotations[0].args.length > 0 ? annotations[0].args[0].text : undefined;
}

/**
 * Factory for @db.rel.onDelete / @db.rel.onUpdate — identical validation logic,
 * only the annotation name and description verb differ.
 */
export function refActionAnnotation(name: "onDelete" | "onUpdate"): AnnotationSpec {
  return new AnnotationSpec({
    description:
      `Referential action when the target ${name === "onDelete" ? "row is deleted" : "key is updated"}. Only valid on @db.rel.FK fields.\n\n` +
      "**Example:**\n" +
      "```atscript\n" +
      "@db.rel.FK\n" +
      `@db.rel.${name} "cascade"\n` +
      "authorId: User.id\n" +
      "```\n",
    nodeType: ["prop"],
    argument: {
      name: "action",
      type: "string",
      values: ["cascade", "restrict", "noAction", "setNull", "setDefault"],
      description:
        'Referential action: "cascade", "restrict", "noAction", "setNull", or "setDefault".',
    },
    validate(token, args, _doc) {
      const errors = [] as TMessages;
      const field = token.parentNode!;

      if (field.countAnnotations("db.rel.FK") === 0) {
        errors.push({
          message: `@db.rel.${name} is only valid on @db.rel.FK fields`,
          severity: 1,
          range: token.range,
        });
      }

      if (args[0]) {
        const action = args[0].text;

        if (action === "setNull" && !field.has("optional")) {
          errors.push({
            message: `@db.rel.${name} "setNull" requires the FK field to be optional (?)`,
            severity: 1,
            range: token.range,
          });
        }

        if (
          action === "setDefault" &&
          field.countAnnotations("db.default") === 0 &&
          field.countAnnotations("db.default.increment") === 0 &&
          field.countAnnotations("db.default.uuid") === 0 &&
          field.countAnnotations("db.default.now") === 0
        ) {
          errors.push({
            message: `@db.rel.${name} "setDefault" but no @db.default.* annotation — field will have no fallback value`,
            severity: 2,
            range: token.range,
          });
        }
      }

      // D5: Multiple onDelete/onUpdate in same composite FK group
      const fkAlias = getAnnotationAlias(field, "db.rel.FK");
      if (fkAlias) {
        const struct = getParentStruct(token);
        if (struct) {
          const annotationName = `db.rel.${name}`;
          let count = 0;
          for (const [, prop] of struct.props) {
            if (prop.countAnnotations("db.rel.FK") === 0) {
              continue;
            }
            if (prop.countAnnotations(annotationName) === 0) {
              continue;
            }
            const propFkAlias = getAnnotationAlias(prop, "db.rel.FK");
            if (propFkAlias === fkAlias) {
              count++;
            }
          }
          if (count > 1) {
            errors.push({
              message: `Composite FK '${fkAlias}' has @db.rel.${name} on multiple fields — declare it on exactly one`,
              severity: 1,
              range: token.range,
            });
          }
        }
      }

      return errors;
    },
  });
}
