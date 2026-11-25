import {
  AnnotationSpec,
  annotationExample,
  type AtscriptDoc,
  isArray,
  isConst,
  isGroup,
  isInterface,
  isPrimitive,
  isRef,
  isStructure,
  type SemanticInterfaceNode,
  type SemanticNode,
  type SemanticPropNode,
  type SemanticStructureNode,
  type Token,
  type TMessages,
} from "@atscript/core";

import { SEARCH_PROBLEM, searchKindOf } from "./search-fields";

/**
 * Names of a field's effective annotations: its own plus the ones it inherits
 * through its type ref (`price: Order.price`), with the `passedWhenReferred:
 * false` ones dropped — the set codegen writes into the field's runtime
 * metadata (`AtscriptDoc.evalAnnotationsForNode`). Compile checks that mirror
 * a runtime metadata check read this, not the own-only `countAnnotations`.
 * @since 0.1.162
 */
export function effectiveAnnotationNames(field: SemanticNode, doc?: AtscriptDoc): Set<string> {
  const names = new Set(field.annotations?.map((a) => a.name));
  // Without a doc (callers built against <= 0.1.161) only the field's own annotations count.
  for (const a of doc?.evalAnnotationsForNode(field) ?? []) names.add(a.name);
  return names;
}

/**
 * Asserts the field carrying this annotation does not also carry any of
 * `others` — its own or inherited through its type ref (since 0.1.162).
 */
export function validateExclusiveWith(
  token: Token,
  selfName: string,
  others: Array<{ key: string; displayName?: string }>,
  doc?: AtscriptDoc,
): TMessages {
  const errors = [] as TMessages;
  const field = token.parentNode!;
  const effective = effectiveAnnotationNames(field, doc);
  for (const { key, displayName } of others) {
    if (!effective.has(key)) continue;
    const inherited = field.countAnnotations(key) === 0;
    errors.push({
      message: inherited
        ? `${selfName} cannot coexist with ${displayName ?? `@${key}`}, which this field inherits from its type reference — pick one form, not both`
        : `${selfName} cannot coexist with ${displayName ?? `@${key}`} on the same field — pick one form, not both`,
      severity: 1,
      range: token.range,
    });
  }
  return errors;
}

/**
 * Reports each of `pairs` (`[annotation, why]`) the field carrying `token`
 * also carries — its own or inherited through its type ref (the field's
 * effective annotations, what the runtime mirror reads off the metadata):
 * `${tag} cannot coexist with @${annotation} — ${why}`.
 * @since 0.1.162
 */
export function validateIncompatible(
  token: Token,
  tag: string,
  pairs: ReadonlyArray<readonly [annotation: string, why: string]>,
  doc?: AtscriptDoc,
): TMessages {
  const effective = effectiveAnnotationNames(token.parentNode!, doc);
  return pairs
    .filter(([name]) => effective.has(name))
    .map(([name, why]) => ({
      message: `${tag} cannot coexist with @${name} — ${why}`,
      severity: 1 as const,
      range: token.range,
    }));
}

/** Whether a prop is a field of a view interface (`@db.view` / `@db.view.for`). */
export function isViewField(field: SemanticNode): boolean {
  const struct = field.ownerNode;
  const owner = struct && isStructure(struct) ? struct.ownerNode : undefined;
  return (
    !!owner &&
    isInterface(owner) &&
    (owner.countAnnotations("db.view") > 0 || owner.countAnnotations("db.view.for") > 0)
  );
}

/** Primitive base type (`string`, `number`, `decimal`, …) of a resolved definition, if it is a primitive. */
export function primitiveBaseType(def: SemanticNode | undefined): string | undefined {
  if (!def || !isPrimitive(def)) return undefined;
  const ct = def.config.type;
  return typeof ct === "object" ? (ct.kind === "final" ? ct.value : ct.kind) : ct;
}

/**
 * `null` in a type expression: the `null` reference or the `null` primitive
 * (whose `config.type` is `"null"`).
 */
export function isNullMember(node: SemanticNode): boolean {
  return (
    (isRef(node) && !node.hasChain && node.id === "null") || primitiveBaseType(node) === "null"
  );
}

/**
 * Whether a definition is a union with a `null` member — `T | null`, or a
 * ref to an alias of one (compile-time mirror of the runtime nullable union,
 * since 0.1.155).
 */
export function isNullableUnion(
  def: SemanticNode | undefined,
  doc: AtscriptDoc,
  depth = 0,
): boolean {
  if (!def || depth > 8) return false;
  if (isNullMember(def)) return true;
  if (isRef(def)) {
    return isNullableUnion(doc.unwindType(def.id!, def.chain)?.def, doc, depth + 1);
  }
  const group = def as SemanticNode & {
    isGroup?: boolean;
    op?: string;
    unwrap?: () => SemanticNode[];
  };
  if (!group.isGroup || group.op !== "|" || isStructure(def)) return false;
  return group.unwrap!().some((member) => isNullableUnion(member, doc, depth + 1));
}

/**
 * Resolves a field/prop's primitive base type, or `undefined` if it isn't a
 * ref-to-primitive. The ref resolves in the document it is written in — an
 * inherited field's may be another file.
 */
function getPrimitiveBaseType(node: SemanticNode, doc: AtscriptDoc): string | undefined {
  const def = node.getDefinition();
  if (!def || !isRef(def)) return undefined;
  return primitiveBaseType(doc.unwindRef(def)?.def);
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
  // Effective annotations — what the runtime check reads off the field's
  // metadata (`@expect.int` travels through a ref; `increment` / `now` /
  // `precision` do not)
  const effective = effectiveAnnotationNames(field, doc);
  const kind = searchKindOf({
    base,
    tags: isPrimitive(leaf) ? leaf.tags : undefined,
    expectInt: effective.has("expect.int"),
    increment: effective.has("db.default.increment"),
    now: effective.has("db.default.now"),
    precision: effective.has("db.column.precision"),
  });
  if (typeof kind === "object") {
    // A view column cannot take @db.default.increment — don't suggest it
    if (kind.problem === SEARCH_PROBLEM.float && isViewField(field)) {
      return { problem: SEARCH_PROBLEM.floatViewField };
    }
    return kind;
  }
  return { kind: kind === "integer" ? "integer" : base === "string" ? "string" : "other" };
}

/**
 * Why an integer fulltext member is not index-backed (its exact-number match
 * would scan — or fail on MongoDB next to `$text`), or `undefined`. Backed:
 * `_id` or the first `@meta.id` of an interface's fields (an inline nested
 * object's are no key of the row, like at runtime), or the first field (in
 * declaration order) of a `@db.index.plain` / `@db.index.unique` group. The
 * fields include the inherited ones ({@link getTypeFields}; `doc` since 0.1.192).
 */
export function integerMemberIndexProblem(token: Token, doc: AtscriptDoc): string | undefined {
  const field = token.parentNode!;
  const struct = getParentStruct(token);
  const fields = getTypeFields(struct, doc);
  if (!struct || !fields) return undefined;
  const props = [...fields.values()];
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

/**
 * Asserts `args[0]` names a sibling property — declared or inherited
 * ({@link getTypeFields}) — that is no primitive of another base type than
 * `string`. A sibling whose type it cannot classify (a union, an object, an
 * unresolved ref) is let through; the editor offers only the string-valued
 * ones ({@link siblingStringFields}).
 */
export function validateSiblingStringField(
  token: Token,
  args: Token[],
  doc: AtscriptDoc,
  selfName: string,
): TMessages {
  const errors = [] as TMessages;
  const fieldName = args[0]?.text;
  if (!fieldName) return errors;

  const fields = getTypeFields(getParentStruct(token), doc);
  if (!fields) return errors;

  const sibling = fields.get(fieldName);
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
 * What the editor offers for a sibling-field argument on the field carrying
 * `token`: the other fields of its type, declared or inherited
 * ({@link getTypeFields}), that hold string values — a `string` (or an alias
 * of one, or a string primitive such as `db.currencyCode`), optional or
 * `| null`, or a union of string literals. Never the field itself, an
 * object, a number or a dotted path. {@link validateSiblingStringField}
 * accepts each of them, and also lets through a field whose type it cannot
 * classify.
 * @since 0.1.192
 */
export function siblingStringFields(token: Token, doc: AtscriptDoc): SemanticPropNode[] {
  const field = token.parentNode;
  const fields = getTypeFields(getParentStruct(token), doc)?.values() ?? [];
  return [...fields].filter((prop) => prop !== field && isStringValued(prop.getDefinition(), doc));
}

/**
 * Whether a type holds only string values: a string primitive, a string
 * literal, a ref to one (resolved where it is written), or a union of those
 * with `null`.
 */
function isStringValued(def: SemanticNode | undefined, doc: AtscriptDoc, depth = 0): boolean {
  if (!def || depth > 8) return false;
  if (isRef(def)) {
    const unwound = doc.unwindRef(def);
    return isStringValued(unwound?.def, unwound?.doc ?? doc, depth + 1);
  }
  if (isGroup(def)) {
    if (def.op !== "|") return false;
    const values = def.unwrap().filter((member) => !isNullMember(member));
    return values.length > 0 && values.every((member) => isStringValued(member, doc, depth + 1));
  }
  if (isPrimitive(def)) return primitiveBaseType(def) === "string";
  return isConst(def) && def.token("identifier")?.type === "text";
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
 * Get the parent structure node from an annotation token — the structure
 * that DECLARES the annotated field (see {@link getTypeFields} for the fields
 * of the type, inherited ones included).
 */
export function getParentStruct(token: Token): SemanticStructureNode | undefined {
  const field = token.parentNode!;
  const struct = field.ownerNode;
  return struct && isStructure(struct) ? (struct as SemanticStructureNode) : undefined;
}

/**
 * The fields of a type by name: the ones it declares and, for an interface
 * with `extends` (or the structure such an interface declares), the ones it
 * inherits — `AtscriptDoc.resolveInterfaceExtends`; an inherited field keeps
 * the structure that declares it as its `ownerNode`. A table has them all at
 * run time, so a check that looks across the fields of a table (the sibling
 * an argument names, the version column, foreign keys, index groups) reads
 * these; a rule about where an annotation is written reads the declaring
 * interface ({@link getDbTableOwner}). The `extends` names resolve in the
 * document that declares the interface (`AtscriptDoc.declaringDoc`); `doc`
 * stands in only where that document is not known. `undefined` when `node`
 * is neither an interface nor a structure.
 * @since 0.1.192
 */
export function getTypeFields(
  node: SemanticNode | undefined,
  doc: AtscriptDoc,
): ReadonlyMap<string, SemanticPropNode> | undefined {
  const owner = isStructure(node) && isInterface(node.ownerNode) ? node.ownerNode : node;
  if (!isInterface(owner)) return isStructure(node) ? node.props : undefined;
  const merged = owner.hasExtends
    ? doc.declaringDoc(owner, doc).resolveInterfaceExtends(owner)
    : undefined;
  const def = isStructure(merged) ? merged : owner.getDefinition();
  return isStructure(def) ? def.props : undefined;
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

/** A `@db.table` interface's table name: its `@db.table` argument, else its name. */
function declaredTableName(iface: SemanticNode): string | undefined {
  const table = iface.annotations?.find((a) => a.name === "db.table");
  return table ? (table.args[0]?.text ?? iface.id) : undefined;
}

/**
 * The `@db.rel.from` / `@db.rel.via` relations a `@db.table` interface
 * inherits (`extends`) from a table with ANOTHER name: the child's (or
 * junction's) foreign key references that table, not this one, so this table
 * cannot load or write them — a warning on the `@db.table` annotation (writes
 * of them are refused at run time). The fix is to declare the relation on
 * each table instead of inheriting it: an inherited field cannot be
 * redeclared (the compiler refuses an override in `extends`), and a second
 * relation under another name leaves the inherited one in place.
 */
export function inheritedForeignRelations(token: Token, doc: AtscriptDoc): TMessages {
  const owner = token.parentNode;
  if (!owner || !isInterface(owner) || !owner.hasExtends) return [];
  const thisTable = declaredTableName(owner);
  const ownDef = owner.getDefinition();
  const own = isStructure(ownDef) ? ownDef.props : new Map();
  const messages = [] as TMessages;
  const reported = new Set<string>();
  const seen = new Set<SemanticNode>();
  const visit = (iface: SemanticInterfaceNode, ifaceDoc: AtscriptDoc) => {
    for (const ext of iface.extendsTokens) {
      const unwound = ifaceDoc.unwindType(ext.text);
      const base = unwound?.def;
      if (!base || !isInterface(base) || seen.has(base)) continue;
      seen.add(base);
      const baseTable = declaredTableName(base);
      const baseDef = base.getDefinition();
      if (baseTable !== undefined && baseTable !== thisTable && isStructure(baseDef)) {
        for (const [name, prop] of baseDef.props) {
          if (own.has(name) || reported.has(name)) continue;
          const kind =
            prop.countAnnotations("db.rel.from") > 0
              ? "from"
              : prop.countAnnotations("db.rel.via") > 0
                ? "via"
                : undefined;
          if (!kind) continue;
          reported.add(name);
          messages.push({
            message:
              `Inherited relation "${name}" (@db.rel.${kind}) is linked to "${baseTable}", not to "${thisTable}" — ` +
              `here its nested writes are refused and it loads nothing; declare it on each table instead of inheriting it (an inherited field cannot be redeclared)`,
            severity: 2,
            range: token.range,
          });
        }
      }
      visit(base, unwound.doc);
    }
  };
  visit(owner, doc);
  return messages;
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
    description: annotationExample(
      `Referential action when the target ${name === "onDelete" ? "row is deleted" : "key is updated"}. Only valid on @db.rel.FK fields.`,
      "@db.rel.FK",
      `@db.rel.${name} "cascade"`,
      "authorId: User.id",
    ),
    nodeType: ["prop"],
    passedWhenReferred: false,
    argument: {
      name: "action",
      type: "string",
      values: ["cascade", "restrict", "noAction", "setNull", "setDefault"],
      description:
        'Referential action: "cascade", "restrict", "noAction", "setNull", or "setDefault".',
    },
    validate(token, args, doc) {
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
        const fields = getTypeFields(getParentStruct(token), doc);
        if (fields) {
          const annotationName = `db.rel.${name}`;
          let count = 0;
          for (const [, prop] of fields) {
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
