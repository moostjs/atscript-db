import type { AtscriptDoc, SemanticStructureNode } from "@atscript/core";

import { getTypeFields } from "./annotation-utils";

/** `reason` of a `$groupBy` / bucket rejection for a field outside a strict aggregate table's dimensions. */
export const NOT_DIMENSION_REASON = "not a dimension";

/**
 * Editor-time twin of the runtime `isStrictTable`: a table whose structure
 * declares any `@db.column.dimension` or `@db.column.measure` is strict —
 * only dimensions can be grouped by. With `doc` (since 0.1.192) the fields
 * the table inherits count too ({@link getTypeFields}), as at run time;
 * without it, only the structure's own fields.
 * @since 0.1.148
 */
export function isStrictAggregateStruct(struct: SemanticStructureNode, doc?: AtscriptDoc): boolean {
  const fields = (doc && getTypeFields(struct, doc)) ?? struct.props;
  for (const prop of fields.values()) {
    if (
      prop.countAnnotations("db.column.dimension") > 0 ||
      prop.countAnnotations("db.column.measure") > 0
    ) {
      return true;
    }
  }
  return false;
}
