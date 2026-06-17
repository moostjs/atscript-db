import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import { resolveDesignType } from "@atscript/db";

// Appends `segment` to a dotted path, omitting the leading dot when `prefix` is
// empty — the accumulator step shared by every segment walk over dotted schema
// paths (schema sync, search-index mapping, mapping-tree traversal).
export function joinPath(prefix: string, segment: string): string {
  return prefix ? `${prefix}.${segment}` : segment;
}

// True when `path` resolves to an array type in the flattened schema. Used to
// decide where a path crosses an array boundary (Mongo `$[]` positional, Atlas
// `embeddedDocuments` container) — the lookup + `resolveDesignType` check that
// schema sync and search-index mapping all share.
export function isArrayPath(
  flatMap: ReadonlyMap<string, TAtscriptAnnotatedType>,
  path: string,
): boolean {
  const type = flatMap.get(path);
  return type !== undefined && resolveDesignType(type) === "array";
}

// True when any dot-boundary ancestor of `path` is present in `set` — e.g.
// `a.b.c` has ancestors `a` and `a.b`. Mongo rejects an operation that names
// both an ancestor and its descendant (a $project with {parent: 1, "parent.x": 1}
// is error 31249; an $unset of both is conflict error 40), so callers use this
// to keep only the shallowest paths. Ancestors are sliced on real dot boundaries
// rather than tested with startsWith, so `a.bc` is never treated as a child of
// `a.b`.
export function hasAncestorIn(path: string, set: ReadonlySet<string>): boolean {
  let dot = path.indexOf(".");
  while (dot !== -1) {
    if (set.has(path.slice(0, dot))) {
      return true;
    }
    dot = path.indexOf(".", dot + 1);
  }
  return false;
}
