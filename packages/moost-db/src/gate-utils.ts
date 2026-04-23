import type { FilterExpr } from "@atscript/db";

/**
 * Walks a Uniquery filter expression and returns the first field name that
 * fails the `isAllowed` predicate, or `undefined` if every leaf field is
 * allowed. Logical combinators (`$and`, `$or`, `$nor`, `$not`) are traversed;
 * other `$`-prefixed keys are skipped.
 *
 * Shared by the DB readable's `@db.column.filterable` gate and the value-help
 * controller's `@ui.dict.filterable` gate — only the predicate differs.
 */
export function findFilterOffender(
  filter: FilterExpr | undefined,
  isAllowed: (field: string) => boolean,
): string | undefined {
  if (!filter || typeof filter !== "object") {
    return undefined;
  }
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" || key === "$or" || key === "$nor") {
      if (Array.isArray(value)) {
        for (const sub of value) {
          const inner = findFilterOffender(sub as FilterExpr, isAllowed);
          if (inner) return inner;
        }
      }
      continue;
    }
    if (key === "$not") {
      const inner = findFilterOffender(value as FilterExpr, isAllowed);
      if (inner) return inner;
      continue;
    }
    if (key.startsWith("$")) {
      continue;
    }
    if (!isAllowed(key)) {
      return key;
    }
  }
  return undefined;
}

/**
 * Walks a Uniquery `$sort` control (accepts string, string[], object, or
 * array-of-{field: dir}) and returns the first field name that fails the
 * `isAllowed` predicate, or `undefined` if every sort key is allowed.
 *
 * Shared by the DB readable's `@db.column.sortable` gate and the value-help
 * controller's `@ui.dict.sortable` gate.
 */
export function findSortOffender(
  sort: unknown,
  isAllowed: (field: string) => boolean,
): string | undefined {
  if (!sort) return undefined;
  const check = (name: string): string | undefined => (isAllowed(name) ? undefined : name);
  if (typeof sort === "string") {
    for (const part of sort.split(",")) {
      const name = part.trim().replace(/^[-+]/, "").split(":")[0];
      if (name) {
        const bad = check(name);
        if (bad) return bad;
      }
    }
    return undefined;
  }
  if (Array.isArray(sort)) {
    for (const entry of sort) {
      if (typeof entry === "string") {
        const bad = check(entry.replace(/^[-+]/, ""));
        if (bad) return bad;
      } else if (entry && typeof entry === "object") {
        for (const name of Object.keys(entry)) {
          const bad = check(name);
          if (bad) return bad;
        }
      }
    }
    return undefined;
  }
  if (typeof sort === "object") {
    for (const name of Object.keys(sort)) {
      const bad = check(name);
      if (bad) return bad;
    }
  }
  return undefined;
}
