import type { WithRelation } from "@uniqu/core";

/**
 * Rewrites dotted `$with` names into nesting (since 0.1.165):
 * `{ name: "a.b", filter, controls }` becomes
 * `{ name: "a", controls: { $with: [{ name: "b", filter, controls }] } }`,
 * at every depth. Entries naming the same relation at one level are merged
 * into one — the first one's `filter` / `controls` win, the nested `$with`
 * lists are concatenated — so `$with=a($select=x),a.b` loads `a` once with
 * `b` nested in it. Before, a dotted name was silently skipped.
 *
 * Returns the input array itself when no entry at any level is dotted or a
 * string (the common case allocates nothing). String entries (`"a"`, `"a.b"`
 * — the shorthand the `$with` type admits) are read as `{ name }`.
 */
export function nestDottedWith<T extends WithRelation | string>(withRelations: readonly T[]): T[] {
  if (!withRelations.some(needsRewrite)) return withRelations as T[];
  const out: WithRelation[] = [];
  const byName = new Map<string, WithRelation>();
  for (const raw of withRelations) {
    const rel: WithRelation = typeof raw === "string" ? { name: raw } : (raw as WithRelation);
    const dot = rel.name.indexOf(".");
    const head = dot < 0 ? rel.name : rel.name.slice(0, dot);
    const entry: WithRelation =
      dot < 0
        ? { ...rel }
        : {
            name: head,
            controls: { $with: [{ ...rel, name: rel.name.slice(dot + 1) }] },
          };
    const existing = byName.get(head);
    if (!existing) {
      byName.set(head, entry);
      out.push(entry);
      continue;
    }
    // Merge into the first entry of that name: its filter / controls stay,
    // nested `$with` lists concatenate.
    const extra = entry.controls?.$with as WithRelation[] | undefined;
    existing.filter ??= entry.filter;
    const controls = { ...entry.controls, ...existing.controls } as Record<string, unknown>;
    const nested = [
      ...((existing.controls?.$with as WithRelation[] | undefined) ?? []),
      ...(extra ?? []),
    ];
    if (nested.length > 0) controls.$with = nested;
    existing.controls = controls as WithRelation["controls"];
  }
  for (const entry of out) {
    const nested = entry.controls?.$with as WithRelation[] | undefined;
    if (nested?.length) {
      const next = nestDottedWith(nested);
      if (next !== nested) entry.controls = { ...entry.controls, $with: next };
    }
  }
  return out as T[];
}

/**
 * An entry is rewritten when it (or a nested one) is dotted, or is the
 * string shorthand (typed as allowed, but the loaders read `.name`).
 */
function needsRewrite(raw: WithRelation | string): boolean {
  if (typeof raw === "string") return true;
  if (raw.name.includes(".")) return true;
  const nested = raw.controls?.$with as Array<WithRelation | string> | undefined;
  return Array.isArray(nested) && nested.some(needsRewrite);
}
