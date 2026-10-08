import type { FilterExpr } from "@uniqu/core";

import { isPlainObject } from "../shared/object";
import type { TableMetadata } from "../table/table-metadata";
import { INTEGER_REGEX_OP } from "../shared/search-term";
import { isIntegerTextField } from "./filter-values";

export { INTEGER_REGEX_OP };

/** Rewrites one field entry; returns the same value when it has no pattern match. */
function rewriteEntry(value: unknown): unknown {
  if (value instanceof RegExp) return { [INTEGER_REGEX_OP]: value };
  if (isPlainObject(value) && "$regex" in value) {
    const out: Record<string, unknown> = {};
    for (const [op, operand] of Object.entries(value)) {
      out[op === "$regex" ? INTEGER_REGEX_OP : op] = operand;
    }
    return out;
  }
  return value;
}

/**
 * `$regex` (and a bare `RegExp`) on integer search members →
 * {@link INTEGER_REGEX_OP}, on the LOGICAL filter. Copy-on-write: the very
 * same object comes back when nothing changed. Relational predicates are
 * rewritten by the related table when it translates them.
 */
export function rewriteIntegerRegex(filter: FilterExpr, meta: TableMetadata): FilterExpr {
  if (!isPlainObject(filter)) return filter;
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    let next = value;
    if (key === "$and" || key === "$or") {
      if (Array.isArray(value)) {
        const mapped = value.map((f) => rewriteIntegerRegex(f as FilterExpr, meta));
        if (mapped.some((m, i) => m !== value[i])) next = mapped;
      }
    } else if (key === "$not") {
      next = rewriteIntegerRegex(value as FilterExpr, meta);
    } else if (!key.startsWith("$") && !meta.navFields.has(key)) {
      const fd = meta.descriptorByPath.get(key);
      if (fd && isIntegerTextField(meta, fd)) next = rewriteEntry(value);
    }
    if (next !== value) {
      out ??= { ...(filter as Record<string, unknown>) };
      out[key] = next;
    }
  }
  return (out ?? filter) as FilterExpr;
}
