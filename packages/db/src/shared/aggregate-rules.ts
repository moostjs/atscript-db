import type { SemanticStructureNode } from "@atscript/core";

/** `reason` of a `$groupBy` / bucket rejection for a field outside a strict aggregate table's dimensions. */
export const NOT_DIMENSION_REASON = "not a dimension";

/**
 * Editor-time twin of the runtime `isStrictTable`: a table whose structure
 * declares any `@db.column.dimension` or `@db.column.measure` is strict —
 * only dimensions can be grouped by.
 * @since 0.1.148
 */
export function isStrictAggregateStruct(struct: SemanticStructureNode): boolean {
  for (const prop of struct.props.values()) {
    if (
      prop.countAnnotations("db.column.dimension") > 0 ||
      prop.countAnnotations("db.column.measure") > 0
    ) {
      return true;
    }
  }
  return false;
}
