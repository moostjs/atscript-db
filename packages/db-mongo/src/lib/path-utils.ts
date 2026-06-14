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
