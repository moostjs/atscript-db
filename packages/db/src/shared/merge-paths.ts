import type { TAtscriptAnnotatedType, TAtscriptTypeObject } from "@atscript/typescript/utils";

import { storedObjectType } from "./union-shape";

const memo = new WeakMap<TAtscriptAnnotatedType, ReadonlySet<string>>();

/**
 * The dot-paths of the objects and arrays below `root` whose
 * `@db.patch.strategy "merge"` applies — those a patch reaches by their own
 * path, through stored objects only ({@link storedObjectType}: a `T | null`
 * is a `T`). Below an array or tuple element, a union member or a `@db.json`
 * / `@db.encrypted` field, and on such a field itself, it is inert. The one
 * answer every patch path reads; memoized per type.
 * @since 0.1.184
 */
export function mergeStrategyPaths(root: TAtscriptAnnotatedType): ReadonlySet<string> {
  let paths = memo.get(root);
  if (paths) return paths;
  const out = new Set<string>();
  const onPath = new Set<object>();
  const visit = (type: TAtscriptAnnotatedType<TAtscriptTypeObject>, prefix: string): void => {
    if (onPath.has(type.type)) return; // a recursive type
    onPath.add(type.type);
    for (const [key, prop] of type.type.props) {
      const meta = prop.metadata;
      if (meta.has("db.json") || meta.has("db.encrypted")) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const merge = meta.get("db.patch.strategy") === "merge";
      const object = storedObjectType(prop);
      if (object) visit(object, path);
      if (merge && (object || prop.type.kind === "array")) out.add(path);
    }
    onPath.delete(type.type);
  };
  const object = storedObjectType(root);
  if (object) visit(object, "");
  memo.set(root, (paths = out));
  return paths;
}
