import type { AtscriptDoc, SemanticNode, SemanticRefNode, TMessages } from "@atscript/core";
import { isArray, isInterface, isProp, isRef, isStructure } from "@atscript/core";

import { SUPPORTED_AGGREGATE_FNS, NULL_WHEN_EMPTY_AGGREGATE_FNS } from "../query/aggregate-fns";
import { primitiveBaseType } from "./annotation-utils";
import { viewJoins } from "./validation-utils";

/** `@db.agg.*` annotations that are never NULL (the counts: 0 over no value). */
const NULL_SAFE_AGG_ANNOTATIONS = SUPPORTED_AGGREGATE_FNS.filter(
  (fn) => !NULL_WHEN_EMPTY_AGGREGATE_FNS.has(fn),
).map((fn) => `db.agg.${fn}`);

/** Primitive leaf types a JSON-stored path may end at. */
const JSON_LEAF_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean"]);

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
  const typeName = ref.id;
  const chain = ref.chain.map((t) => t.text);
  if (!typeName || chain.length < 2) return [];
  let throughJson = false;
  for (let i = 1; i < chain.length; i++) {
    const step = doc.unwindType(typeName, chain.slice(0, i));
    if (!step) return [];
    const stepNode = step.node;
    if (
      (stepNode && isProp(stepNode) && stepNode.countAnnotations("db.json") > 0) ||
      isArray(step.def)
    ) {
      throughJson = true;
      break;
    }
  }
  if (!throughJson) return [];
  const leaf = doc.unwindType(typeName, chain)?.def;
  const leafType = primitiveBaseType(leaf);
  if (leafType !== undefined && JSON_LEAF_TYPES.has(leafType)) return [];
  return [
    {
      message:
        `Field "${fieldName}" reads "${typeName}.${chain.join(".")}" inside a JSON-stored field — ` +
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
