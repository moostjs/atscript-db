import type { AtscriptDoc, SemanticNode, SemanticRefNode, TMessages } from "@atscript/core";
import { isArray, isInterface, isProp, isRef, isStructure } from "@atscript/core";

import { SUPPORTED_AGGREGATE_FNS, NULL_WHEN_EMPTY_AGGREGATE_FNS } from "../query/aggregate-fns";
import { primitiveBaseType } from "./annotation-utils";
import { JSON_LEAF_TYPES } from "./derived-rules";
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

/** Props of a view interface (its own structure; views don't use `extends`). */
function viewProps(owner: SemanticNode): Map<string, SemanticNode> | undefined {
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
