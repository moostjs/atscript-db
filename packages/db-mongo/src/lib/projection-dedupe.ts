// Drops descendant include keys when their parent is already included: Mongo's
// $project rejects {parent: 1, "parent.leaf": 1} with error 31249, and the
// parent include already covers every leaf. Exclusions (`_id: 0`) pass through.
export function dedupeProjection<V extends 0 | 1>(
  projection: Record<string, V>,
): Record<string, V> {
  const includeKeys = Object.keys(projection).filter((k) => projection[k] === 1);
  if (includeKeys.length < 2) return projection;
  const toRemove = new Set<string>();
  for (const parent of includeKeys) {
    const prefix = parent + ".";
    for (const other of includeKeys) {
      if (other !== parent && other.startsWith(prefix)) toRemove.add(other);
    }
  }
  if (toRemove.size === 0) return projection;
  const result: Record<string, V> = {};
  for (const k of Object.keys(projection)) {
    if (!toRemove.has(k)) result[k] = projection[k];
  }
  return result;
}
