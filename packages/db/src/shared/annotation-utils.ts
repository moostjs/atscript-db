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

import { searchKindOf } from "./search-fields";

/** Asserts the field carrying this annotation does not also carry any of `others`. */
export function validateExclusiveWith(
  token: Token,
  selfName: string,
  others: Array<{ key: string; displayName?: string }>,
): TMessages {
  const errors = [] as TMessages;
  const field = token.parentNode!;
  for (const { key, displayName } of others) {
    if (field.countAnnotations(key) > 0) {
      errors.push({
        message: `${selfName} cannot coexist with ${displayName ?? `@${key}`} on the same field — pick one form, not both`,
        severity: 1,
        range: token.range,
      });
    }
  }
  return errors;
}

/** Primitive base type (`string`, `number`, `decimal`, …) of a resolved definition, if it is a primitive. */
export function primitiveBaseType(def: SemanticNode | undefined): string | undefined {
  if (!def || !isPrimitive(def)) return undefined;
  const ct = def.config.type;
  return typeof ct === "object" ? (ct.kind === "final" ? ct.value : ct.kind) : ct;
}

/** Resolves a field/prop's primitive base type, or `undefined` if it isn't a ref-to-primitive. */
function getPrimitiveBaseType(node: SemanticNode, doc: AtscriptDoc): string | undefined {
  const def = node.getDefinition();
  if (!def || !isRef(def)) return undefined;
  return primitiveBaseType(doc.unwindType(def.id!, def.chain)?.def);
}

/**
 * Whether a prop takes part in `$search` as text or as an integer, or why it
 * cannot (compile-time mirror of the runtime `searchMemberKind`). Anything
 * that is not a ref to a primitive (structures, arrays, unions, unresolved
 * refs) is left alone.
 */
export function searchFieldVerdict(
  field: SemanticNode,
  doc: AtscriptDoc,
): { kind: "string" | "integer" | "other" } | { problem: string } {
  const def = field.getDefinition();
  if (!def || !isRef(def)) return { kind: "other" };
  const leaf = doc.unwindType(def.id!, def.chain)?.def;
  const base = primitiveBaseType(leaf);
  if (base === undefined) return { kind: "other" };
  const kind = searchKindOf({
    base,
    tags: isPrimitive(leaf) ? leaf.tags : undefined,
    expectInt: field.countAnnotations("expect.int") > 0,
    increment: field.countAnnotations("db.default.increment") > 0,
    now: field.countAnnotations("db.default.now") > 0,
    precision: field.countAnnotations("db.column.precision") > 0,
  });
  if (typeof kind === "object") return kind;
  return { kind: kind === "integer" ? "integer" : base === "string" ? "string" : "other" };
}

/**
 * Why an integer fulltext member is not index-backed (its exact-number match
 * would scan — or fail on MongoDB next to `$text`), or `undefined`. Backed:
 * `_id` or the first `@meta.id` of an interface's own fields (an inline
 * nested object's are no key of the row, like at runtime), or the first field
 * (in declaration order) of a `@db.index.plain` / `@db.index.unique` group.
 */
export function integerMemberIndexProblem(token: Token): string | undefined {
  const field = token.parentNode!;
  const struct = getParentStruct(token);
  if (!struct) return undefined;
  const props = [...struct.props.values()];
  const topLevel = !!struct.ownerNode && isInterface(struct.ownerNode);
  if (topLevel && field.id === "_id") return undefined;
  if (
    topLevel &&
    field.countAnnotations("meta.id") > 0 &&
    props.find((p) => p.countAnnotations("meta.id") > 0) === field
  ) {
    return undefined;
  }
  for (const ann of ["db.index.plain", "db.index.unique"]) {
    for (const own of field.annotations?.filter((a) => a.name === ann) ?? []) {
      const group = own.args[0]?.text ?? field.id;
      const first = props.find((p) =>
        p.annotations?.some((a) => a.name === ann && (a.args[0]?.text ?? p.id) === group),
      );
      if (first === field) return undefined;
    }
  }
  return `@db.index.fulltext on the integer field "${field.id}" needs an index for its exact-number match — make it the primary key (first @meta.id) or the first field of a @db.index.plain / @db.index.unique`;
}

/** Asserts `args[0]` names a sibling property whose primitive base type is `string`. */
export function validateSiblingStringField(
  token: Token,
  args: Token[],
  doc: AtscriptDoc,
  selfName: string,
): TMessages {
  const errors = [] as TMessages;
  const fieldName = args[0]?.text;
  if (!fieldName) return errors;

  const struct = getParentStruct(token);
  if (!struct) return errors;

  const sibling = struct.props.get(fieldName);
  if (!sibling) {
    errors.push({
      message: `${selfName} '${fieldName}': no sibling field named '${fieldName}' on this type`,
      severity: 1,
      range: token.range,
    });
    return errors;
  }

  const baseType = getPrimitiveBaseType(sibling, doc);
  if (baseType !== undefined && baseType !== "string") {
    errors.push({
      message: `${selfName} '${fieldName}': sibling field must be a string, got '${baseType}'`,
      severity: 1,
      range: token.range,
    });
  }

  return errors;
}

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
  const baseType = getPrimitiveBaseType(field, doc);
  if (baseType === undefined) return errors;
  const allowed = Array.isArray(expectedType) ? expectedType : [expectedType];
  if (!allowed.includes(baseType)) {
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
    passedWhenReferred: false,
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
