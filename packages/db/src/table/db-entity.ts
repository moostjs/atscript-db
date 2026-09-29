import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import { isAnnotatedType } from "@atscript/typescript/utils";

import { DB_ENTITY_ANNOTATIONS } from "../shared/derived-rules";

/**
 * Whether `value` is a compiled type a `DbSpace` accepts: an annotated type
 * whose own declaration carries `@db.table`, `@db.view` or `@db.view.for`.
 * A `@db.alias` type is not one, and neither is a plain `export type X = Table`
 * or a field typed with a table (`customer: Customer`) — since 0.1.141 the
 * entity annotations stay on the declaring interface instead of travelling
 * with every reference.
 *
 * Filters a module namespace before a sync:
 * `syncSchema(db, Object.values(models).filter(isDbEntityType))`.
 * @since 0.1.141
 */
export function isDbEntityType(value: unknown): value is TAtscriptAnnotatedType {
  if (!isAnnotatedType(value)) {
    return false;
  }
  return DB_ENTITY_ANNOTATIONS.some((name) => value.metadata.has(name as never));
}
