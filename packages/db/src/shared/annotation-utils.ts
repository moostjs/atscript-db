import {
  AnnotationSpec,
  annotationExample,
  type AtscriptDoc,
  documentsEpoch,
  isAnnotate,
  isArray,
  isConst,
  isGroup,
  isInterface,
  isPrimitive,
  isRef,
  isStructure,
  SemanticInterfaceNode,
  type SemanticAnnotateNode,
  type SemanticNode,
  SemanticPropNode,
  type SemanticRefNode,
  SemanticStructureNode,
  type TAnnotationTokens,
  type Token,
  type TMessages,
} from "@atscript/core";

import { SEARCH_PROBLEM, searchKindOf } from "./search-fields";

// ── Where an annotation lands (since 0.1.194) ───────────────────────────────

/**
 * The node a db annotation applies to, in the type it ends up in — the one
 * rule every db check reads its field (or type) through, so an annotation is
 * checked the same way whether it is written on the field or in an
 * `annotate` block:
 *
 * - written on its node (a field, an interface, …): that node;
 * - in an `annotate` block: the node it lands on in the {@link landBlock
 *   landed copy} of the interface the block writes into — an entry's
 *   annotation the top-level field it names, a top-level one the interface;
 * - `undefined` for anything else in a block — a nested entry
 *   (`address.city`), a block on a type that is no interface: such an
 *   annotation is applied, but not checked.
 *
 * Without `doc` (a doc-optional helper called without one) the node it is
 * written on, an annotate block's entry included.
 */
export function annotationTarget(token: Token, doc?: AtscriptDoc): SemanticNode | undefined {
  const node = token.parentNode;
  if (!node || !doc) return node;
  if (isAnnotate(node)) return landBlock(node, doc)?.type;
  if (!isRef(node)) return node;
  const block = entryBlock(node, doc);
  return block ? landBlock(block, doc)?.fields.get(node) : node;
}

/**
 * Declaration `decl` as the annotation carrying `token` sees it: the landed
 * copy when `decl` is the interface the token's `annotate` block writes into
 * — a relation to the same table, completed in the same block — else `decl`
 * (another interface is read as declared).
 */
export function landedDeclaration(
  token: Token,
  doc: AtscriptDoc,
  decl: SemanticNode,
): SemanticNode {
  const node = token.parentNode;
  const block = isAnnotate(node) ? node : isRef(node) ? entryBlock(node, doc) : undefined;
  const landing = block && landBlock(block, doc);
  return landing && landing.decl === decl ? landing.type : decl;
}

/** The `annotate` block an annotated entry belongs to, if `ref` is one. */
function entryBlock(ref: SemanticRefNode, doc: AtscriptDoc): SemanticAnnotateNode | undefined {
  const at = ref.token("identifier")?.range.start;
  const block = at && doc.annotateBlockAt(at.line, at.character);
  return block && block.annotatedEntries.includes(ref) ? block : undefined;
}

/** The landed copy of an `annotate` block (see {@link landBlock}). */
interface TLanding {
  /** The declared interface the block writes into. */
  decl: SemanticNode;
  /** The interface the block writes into, with the block's annotations applied. */
  type: SemanticInterfaceNode;
  /** Each annotated top-level entry → the field it lands on. */
  fields: Map<SemanticRefNode, SemanticPropNode>;
}

/** {@link landBlock} per block, per documents' epoch (any document's change invalidates it). */
const landings = new WeakMap<
  SemanticAnnotateNode,
  { epoch: number; landing: TLanding | undefined }
>();

/**
 * The landed copy of `annotate` block `block` (declared in `doc`): a
 * check-only copy of the interface the block writes into, its fields
 * (inherited ones included) with the block's top-level entries applied —
 * what the checks of an annotation in the block see, as they see a declared
 * interface. `undefined` when the block's target, as the compiler resolves
 * it, is no interface.
 *
 * - `annotate T { … }` writes into T (`AtscriptDoc.blockTarget`): T's fields
 *   with the block's annotations over T's own (`AtscriptDoc.overlayAnnotations`,
 *   the way the block applies them to T's metadata);
 * - `annotate T as U { … }` declares U, a copy of T (`AtscriptDoc.declTarget`):
 *   T's fields with U's entries merged in, and U's type-level annotations
 *   over T's (`AtscriptDoc.evalAnnotationsForNode`). U is a `@db.table` when
 *   T is, and it answers to T's name: the references in its fields, and the
 *   foreign keys to its rows, name T.
 *
 * Other blocks writing into the same interface are not applied (an
 * annotation written on the field does not see them either).
 */
function landBlock(block: SemanticAnnotateNode, doc: AtscriptDoc): TLanding | undefined {
  const epoch = documentsEpoch();
  const known = landings.get(block);
  if (known?.epoch === epoch) return known.landing;
  const landing = buildLanding(block, doc);
  landings.set(block, { epoch, landing });
  return landing;
}

function buildLanding(block: SemanticAnnotateNode, doc: AtscriptDoc): TLanding | undefined {
  const target = block.isMutating ? doc.blockTarget(block) : doc.declTarget(block.targetName);
  const decl = target && ("node" in target ? target.node : target.def);
  if (!target || !isInterface(decl)) return undefined;
  const fields = getTypeFields(decl, target.doc) ?? new Map<string, SemanticPropNode>();
  // (a nested entry lands nowhere: it is not checked; a repeated entry is a compile error)
  const entries = new Map(
    block.annotatedEntries.filter((entry) => !entry.hasChain).map((entry) => [entry.id!, entry]),
  );

  const type = new SemanticInterfaceNode();
  const name = decl.token("identifier");
  if (name) type.carryToken(name, "identifier");
  setAnnotations(
    type,
    block.isMutating
      ? doc.overlayAnnotations(decl.annotations, block.annotations ?? [])
      : doc.evalAnnotationsForNode(block),
  );

  const landed = new Map<SemanticRefNode, SemanticPropNode>();
  const props: SemanticPropNode[] = [];
  for (const [fieldName, prop] of fields) {
    const entry = entries.get(fieldName);
    let annotations = prop.annotations;
    if (entry) {
      annotations = block.isMutating
        ? doc.overlayAnnotations(annotations, entry.annotations!)
        : doc.mergeNodesAnnotations(annotations, entry.annotations!, true);
    }
    const copy = landProp(prop, annotations, target.doc);
    props.push(copy);
    if (entry) landed.set(entry, copy);
  }
  const struct = new SemanticStructureNode();
  struct.setProps(props);
  type.carryDefinition(struct);
  return { decl, type, fields: landed };
}

/**
 * A landed copy of field `prop` (of the interface declared in `doc`)
 * carrying `annotations` (see {@link landBlock}), registered as declared
 * where `prop` is (`AtscriptDoc.declaringDoc`).
 */
function landProp(
  prop: SemanticPropNode,
  annotations: TAnnotationTokens[] | undefined,
  doc: AtscriptDoc,
): SemanticPropNode {
  const landed = new SemanticPropNode();
  for (const key of ["identifier", "optional"] as const) {
    const token = prop.token(key);
    if (token) landed.carryToken(token, key);
  }
  const def = prop.getDefinition();
  if (def) landed.carryDefinition(def);
  setAnnotations(landed, annotations);
  doc.declaringDoc(prop, doc).registerProp(landed);
  return landed;
}

/** Sets a node's annotations and the counts `countAnnotations` reads. */
function setAnnotations(node: SemanticNode, annotations: TAnnotationTokens[] | undefined): void {
  node.annotations = annotations;
  const counts = new Map<string, number>();
  for (const a of annotations ?? []) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
  node.annotationsCounter = counts;
}

/**
 * Names of a field's effective annotations: its own plus the ones it inherits
 * through its type ref (`price: Order.price`), with the `passedWhenReferred:
 * false` ones dropped — the set codegen writes into the field's runtime
 * metadata (`AtscriptDoc.evalAnnotationsForNode`, in the document declaring
 * the field). Compile checks that mirror a runtime metadata check read this,
 * not the own-only `countAnnotations`.
 * @since 0.1.162
 */
export function effectiveAnnotationNames(field: SemanticNode, doc?: AtscriptDoc): Set<string> {
  const names = new Set(field.annotations?.map((a) => a.name));
  // Without a doc (callers built against <= 0.1.161) only the field's own annotations count.
  const fieldDoc = doc?.declaringDoc(field, doc);
  for (const a of fieldDoc?.evalAnnotationsForNode(field) ?? []) names.add(a.name);
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
  // (an annotation that lands nowhere — a nested entry — is read on its entry)
  const field = annotationTarget(token, doc) ?? token.parentNode;
  if (!field) return errors;
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
  // (an annotation that lands nowhere — a nested entry — is read on its entry)
  const field = annotationTarget(token, doc) ?? token.parentNode;
  if (!field) return [];
  const effective = effectiveAnnotationNames(field, doc);
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
    return isNullableUnion(doc.unwindRef(def)?.def, doc, depth + 1);
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
  // (resolved where it is written — an annotate block's field may be another file's)
  const leaf = doc.unwindRef(def)?.def;
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
  const target = annotationTarget(token, doc);
  const struct = getParentStruct(token, doc);
  const fields = getTypeFields(struct, doc);
  if (!target || !struct || !fields) return undefined;
  // (typed: a narrowed `target` in the loops below is a circular inference)
  const field: SemanticNode = target;
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

  const fields = getTypeFields(getParentStruct(token, doc), doc);
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
  const field = annotationTarget(token, doc);
  const fields = getTypeFields(getParentStruct(token, doc), doc)?.values() ?? [];
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
 * The interface whose top-level field the annotation's field is — else the
 * structure holding the field (a nested object, a type's structure) — in the
 * type it ends up in ({@link annotationTarget}; `doc` since 0.1.194):
 * whether the field is a field of a `@db.table` / `@db.view` interface.
 */
export function getDbTableOwner(token: Token, doc?: AtscriptDoc): SemanticNode | undefined {
  const struct = getParentStruct(token, doc);
  if (!struct) {
    return undefined;
  }
  const iface = struct.ownerNode;
  return iface && isInterface(iface) ? iface : struct;
}

/**
 * The structure holding the annotation's field ({@link annotationTarget};
 * `doc` since 0.1.194) — the one that DECLARES it, or for an annotate
 * block's field the one it lands in (see {@link getTypeFields} for the fields
 * of the type, inherited ones included).
 */
export function getParentStruct(
  token: Token,
  doc?: AtscriptDoc,
): SemanticStructureNode | undefined {
  const struct = annotationTarget(token, doc)?.ownerNode;
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
 * Get the parent interface name (for error messages and cross-type
 * resolution) — of the type the field ends up in ({@link annotationTarget};
 * `doc` since 0.1.194).
 */
export function getParentTypeName(token: Token, doc?: AtscriptDoc): string | undefined {
  const struct = getParentStruct(token, doc);
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
  const field = annotationTarget(token, doc);
  if (!field) return errors;
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
  return getNavTargetRef(field)?.id;
}

/**
 * The type reference of a navigational field's target (`Post` of
 * `posts: Post[]`) — its name resolves where it is written
 * (`AtscriptDoc.refOrigin`).
 * @since 0.1.194
 */
export function getNavTargetRef(field: SemanticNode): SemanticRefNode | undefined {
  let def = field.getDefinition();
  if (isArray(def)) {
    def = def?.getDefinition();
  }
  return isRef(def) ? def : undefined;
}

/**
 * Whether annotation `name` on `prop` — a field of the interface `owner` — is
 * written on one of `owner`'s own fields, so its own `validate` checked it as
 * a field of `owner`. Otherwise `owner` inherits it, and a rule over
 * `owner`'s fields is checked on `owner`'s `@db.table` (since 0.1.194).
 */
export function checkedAsFieldOf(prop: SemanticNode, name: string, owner: SemanticNode): boolean {
  const own = owner.getDefinition();
  return (
    !!own &&
    (prop.annotations ?? []).some((a) => a.name === name && a.token.parentNode?.ownerNode === own)
  );
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
      const field = annotationTarget(token, doc);
      if (!field) return errors;

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
        const fields = getTypeFields(getParentStruct(token, doc), doc);
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
