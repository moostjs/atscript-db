import type { AtscriptDoc, SemanticNode, SemanticRefNode, Token, TMessages } from "@atscript/core";
import { isArray, isInterface, isProp, isRef, isStructure } from "@atscript/core";

import {
  AGG_ANNOTATIONS,
  SUPPORTED_AGGREGATE_FNS,
  NULL_WHEN_EMPTY_AGGREGATE_FNS,
} from "../query/aggregate-fns";
import { getAnnotationAlias, isViewField, primitiveBaseType } from "./annotation-utils";
import { JSON_LEAF_TYPES } from "./derived-rules";
import { ENCRYPTED_SEARCH_FEATURES } from "./search-fields";
import { viewJoins } from "./validation-utils";

/** `@db.agg.*` annotations that are never NULL (the counts: 0 over no value). */
const NULL_SAFE_AGG_ANNOTATIONS = SUPPORTED_AGGREGATE_FNS.filter(
  (fn) => !NULL_WHEN_EMPTY_AGGREGATE_FNS.has(fn),
).map((fn) => `db.agg.${fn}`);

/**
 * What a chain type-ref (`Order.payload.customer.id`) reads, as the compiler
 * sees it — the one chain walk views (VW8) and `@db.column.derived` share.
 * @since 0.1.141
 */
export interface TJsonChainInfo {
  /** The referenced type (`Order`). */
  typeName: string;
  /** The chain segments below it (`["payload", "customer", "id"]`). */
  chain: string[];
  /** `false` when a step could not be resolved — the callers stay silent (sync reports it). */
  resolved: boolean;
  /**
   * 1-based index of the first step that is a `@db.json` prop or an array
   * (the JSON root), if any — a `@db.json` prop unless {@link viaArray}.
   */
  jsonRoot?: number;
  /** Some step (the leaf included) is an array. */
  viaArray: boolean;
  /** Some step (the leaf included) is `@db.encrypted`. */
  viaEncrypted: boolean;
  /** Some step (the leaf included) is declared optional. */
  optional: boolean;
  /** Primitive base type of the leaf (`string`, `number`, …), `undefined` when it is not a primitive. */
  leafType?: string;
}

/**
 * Walks a chain ref step by step (`Order.payload`, `Order.payload.customer`, …)
 * and reports the JSON root, arrays, encryption, optionality and the leaf type.
 * A chain shorter than 2 is not a field path (`resolved: false`).
 * @since 0.1.141
 */
export function jsonChainInfo(ref: SemanticRefNode, doc: AtscriptDoc): TJsonChainInfo {
  const typeName = ref.id ?? "";
  const chain = ref.chain.map((t) => t.text);
  const info: TJsonChainInfo = {
    typeName,
    chain,
    resolved: false,
    viaArray: false,
    viaEncrypted: false,
    optional: false,
  };
  if (!typeName || chain.length < 2) return info;
  for (let i = 1; i <= chain.length; i++) {
    const step = doc.unwindType(typeName, chain.slice(0, i));
    if (!step) return info;
    const node = step.node;
    const prop = node && isProp(node) ? node : undefined;
    if (prop?.has("optional")) info.optional = true;
    if (prop && prop.countAnnotations("db.encrypted") > 0) info.viaEncrypted = true;
    const isJsonProp = prop !== undefined && prop.countAnnotations("db.json") > 0;
    const isArr = isArray(step.def);
    if (isArr) info.viaArray = true;
    if (info.jsonRoot === undefined && (isJsonProp || isArr)) {
      info.jsonRoot = i;
    }
    if (i === chain.length) info.leafType = primitiveBaseType(step.def);
  }
  info.resolved = true;
  return info;
}

/** Read seals of a view field ({@link viewFieldSeals}). @since 0.1.162 */
export interface TViewFieldSeals {
  writeOnly: boolean;
  encrypted: boolean;
}

/**
 * The read seals a view field takes from the source field it reads, as the
 * compiler sees them (compile-time mirror of the runtime `sourceFieldSeals`,
 * which stamps them onto the view column — these annotations are
 * `passedWhenReferred: false`, so they are not in the field's own metadata):
 * - `writeOnly` — the source path or an ancestor object is `@db.writeOnly`;
 * - `encrypted` — the source path or an ancestor object is `@db.encrypted`.
 *
 * (A `@db.json` source is no seal: a view reads a primitive JSON column's
 * typed value, and an object one needs its own `@db.json`.)
 *
 * The source is the chain ref (`pin?: Account.pin`), or else the entry table's
 * same-named field (or an aggregate's field) of a `@db.view.for` view. A source
 * field that is itself a view field passes on its own seals. Computed fields
 * and fields of anything but a view report no seal.
 * @since 0.1.162
 */
export function viewFieldSeals(field: SemanticNode, doc: AtscriptDoc, depth = 0): TViewFieldSeals {
  const seals: TViewFieldSeals = { writeOnly: false, encrypted: false };
  if (depth > 8 || !isViewField(field) || field.countAnnotations("db.compute") > 0) return seals;
  let typeName: string | undefined;
  let path: string[];
  const def = field.getDefinition();
  if (def && isRef(def) && (def as SemanticRefNode).hasChain) {
    typeName = def.id;
    path = (def as SemanticRefNode).chain.map((t) => t.text);
  } else {
    const view = field.ownerNode!.ownerNode!;
    typeName = getAnnotationAlias(view, "db.view.for");
    const agg = field.annotations?.find((a) => (AGG_ANNOTATIONS as string[]).includes(a.name));
    const aggField = agg?.args[0]?.text;
    if (agg && (!aggField || aggField === "*")) return seals; // COUNT(*) reads no field
    path = (aggField ?? field.id ?? "").split(".");
  }
  if (!typeName || !path.length || !path[0]) return seals;
  for (let i = 1; i <= path.length; i++) {
    const step = doc.unwindType(typeName, path.slice(0, i));
    if (!step) break;
    const node = step.node;
    if (!node || !isProp(node)) continue;
    if (node.countAnnotations("db.writeOnly") > 0) seals.writeOnly = true;
    if (node.countAnnotations("db.encrypted") > 0) seals.encrypted = true;
    // A view over a view: the source view's field carries its own seals
    const inner = viewFieldSeals(node, step.doc, depth + 1);
    seals.writeOnly ||= inner.writeOnly;
    seals.encrypted ||= inner.encrypted;
  }
  return seals;
}

/**
 * A search annotation (`@db.column.searchable` / `@db.index.fulltext`) on a
 * view field whose source is `@db.writeOnly` — a search hit would reveal the
 * sealed value (the runtime refuses it at sync and on every query), or
 * `undefined`. The field's own `@db.writeOnly` is reported by that spec.
 * @since 0.1.162
 */
export function viewSourceSealProblem(
  token: Token,
  doc: AtscriptDoc,
  annotation: string,
): TMessages[number] | undefined {
  const field = token.parentNode!;
  if (field.countAnnotations("db.writeOnly") > 0) return undefined;
  if (!viewFieldSeals(field, doc).writeOnly) return undefined;
  return {
    message: `${annotation} on "${field.id}", which reads a @db.writeOnly source field — search results would reveal the sealed value`,
    severity: 1,
    range: token.range,
  };
}

/**
 * A search / index feature (`@db.column.searchable`, `@db.index.fulltext`,
 * `@db.index.geo`, `@db.search.vector`, `@db.search.filter`) on a field that
 * would read ciphertext: a field inside an `@db.encrypted` object, or a view
 * field over an encrypted source — or `undefined`. The field's own
 * `@db.encrypted` is reported by that spec.
 * @since 0.1.162
 */
export function encryptedSearchProblem(
  token: Token,
  doc: AtscriptDoc,
  annotation: string,
): TMessages[number] | undefined {
  const field = token.parentNode!;
  if (field.countAnnotations("db.encrypted") > 0) return undefined;
  const where = encryptedAncestorName(field);
  const why =
    where !== undefined
      ? `it is inside the @db.encrypted field "${where}"`
      : viewFieldSeals(field, doc).encrypted
        ? "it reads a @db.encrypted source field"
        : undefined;
  if (!why) return undefined;
  return {
    message: `${annotation} on "${field.id}" — ${why}; search over ciphertext is impossible`,
    severity: 1,
    range: token.range,
  };
}

/** Navigation fields hold another table's rows, never part of this field's value. */
const NAV_ANNOTATIONS = ["db.rel.to", "db.rel.from", "db.rel.via"];

/**
 * A search feature ({@link ENCRYPTED_SEARCH_FEATURES}) declared inside the
 * TYPE of the `@db.encrypted` field carrying `token`, reached through a type
 * ref (`@db.encrypted profile: Address`, where `Address` has
 * `@db.index.fulltext city`) — the shared type's own annotations cannot see
 * that this use encrypts them. Fields declared inline are reported by their
 * own annotation (see {@link encryptedSearchProblem}).
 * @since 0.1.162
 */
export function encryptedTypeSearchProblem(
  token: Token,
  doc: AtscriptDoc,
): TMessages[number] | undefined {
  const field = token.parentNode!;
  const seen = new Set<SemanticNode>();
  const visit = (
    def: SemanticNode | undefined,
    defDoc: AtscriptDoc,
    viaRef: boolean,
    prefix: string,
  ): { path: string; feature: string } | undefined => {
    if (!def || seen.has(def)) return undefined;
    seen.add(def);
    if (isRef(def)) {
      const unwound = defDoc.unwindType(def.id!, (def as SemanticRefNode).chain);
      return unwound ? visit(unwound.def, unwound.doc, true, prefix) : undefined;
    }
    const props = isInterface(def) || isStructure(def) ? def.props : undefined;
    if (!props) return undefined;
    for (const [name, prop] of props) {
      if (NAV_ANNOTATIONS.some((key) => prop.countAnnotations(key) > 0)) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      if (viaRef) {
        const feature = ENCRYPTED_SEARCH_FEATURES.find((key) => prop.countAnnotations(key) > 0);
        if (feature) return { path, feature };
      }
      const found = visit(prop.getDefinition(), defDoc, viaRef, path);
      if (found) return found;
    }
    return undefined;
  };
  const found = visit(field.getDefinition(), doc, false, field.id ?? "");
  if (!found) return undefined;
  return {
    message: `@db.encrypted on "${field.id}" — its type declares @${found.feature} on "${found.path}"; search over ciphertext is impossible`,
    severity: 1,
    range: token.range,
  };
}

/** Name of the nearest `@db.encrypted` prop enclosing `field` (inline nested objects), if any. */
export function encryptedAncestorName(field: SemanticNode): string | undefined {
  for (let node = field.ownerNode; node; node = node.ownerNode) {
    if (isProp(node) && node.countAnnotations("db.encrypted") > 0) return node.id;
  }
  return undefined;
}

/** Props of a view interface (its own structure; views don't use `extends`). */
export function viewProps(owner: SemanticNode): Map<string, SemanticNode> | undefined {
  if (isInterface(owner)) {
    return owner.props as Map<string, SemanticNode>;
  }
  const def = owner.getDefinition();
  return def && isStructure(def) ? (def.props as Map<string, SemanticNode>) : undefined;
}

/**
 * VW8: a chain ref that passes through a `@db.json` or array node reads a
 * JSON leaf, which views can only extract as a string / number / boolean.
 * Intermediate nodes that `unwindType` can't reach are skipped (sync-time
 * resolution reports them).
 */
function validateJsonChain(
  fieldName: string,
  ref: SemanticRefNode,
  doc: AtscriptDoc,
  range: NonNullable<ReturnType<SemanticNode["token"]>>["range"],
): TMessages {
  const info = jsonChainInfo(ref, doc);
  // The JSON root is a step ABOVE the leaf (a leaf that is itself the JSON
  // column or an array reads the whole value, which is not a JSON-leaf read)
  if (!info.resolved || info.jsonRoot === undefined || info.jsonRoot >= info.chain.length) {
    return [];
  }
  if (info.leafType !== undefined && JSON_LEAF_TYPES.has(info.leafType)) return [];
  return [
    {
      message:
        `Field "${fieldName}" reads "${info.typeName}.${info.chain.join(".")}" inside a JSON-stored field — ` +
        `it must end at a string, number or boolean leaf`,
      severity: 1,
      range,
    },
  ];
}

/**
 * Whole-view checks, run once per `@db.view.for` interface:
 *
 * - VW7 — a field reading from a left-joined table must be optional (the
 *   join yields NULL for unmatched rows); `@db.agg.count` / `countDistinct`
 *   fields are exempt (they count 0, never NULL).
 * - VW8 — a chain ref through a `@db.json` or array node must end at a
 *   primitive string / number / boolean leaf.
 * @since 0.1.136
 */
export function validateViewInterface(owner: SemanticNode, doc: AtscriptDoc): TMessages {
  const errors: TMessages = [];
  const props = viewProps(owner);
  if (!props) return errors;

  const leftJoined = new Set<string>();
  for (const join of viewJoins(owner)) {
    const target = join.args[0]?.text;
    if (target && join.args[2]?.text === "left") {
      leftJoined.add(target);
    }
  }

  for (const [fieldName, prop] of props) {
    const def = prop.getDefinition();
    if (!def || !isRef(def)) continue;
    const ref = def as SemanticRefNode;
    const range = (prop.token("identifier") ?? ref.token("identifier"))?.range;
    if (!range) continue;

    if (
      ref.id &&
      leftJoined.has(ref.id) &&
      !prop.has("optional") &&
      !NULL_SAFE_AGG_ANNOTATIONS.some((name) => prop.countAnnotations(name) > 0)
    ) {
      errors.push({
        message: `Field "${fieldName}" reads from left-joined "${ref.id}" and must be optional (${fieldName}?: …)`,
        severity: 1,
        range,
      });
    }

    errors.push(...validateJsonChain(fieldName, ref, doc, range));
  }

  return errors;
}
