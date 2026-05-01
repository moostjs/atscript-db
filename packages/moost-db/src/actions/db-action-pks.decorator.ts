import { createPkParamDecorator } from "./pk-source";

/**
 * Parameter resolver that reads a JSON array of primary keys from the request
 * body and validates each entry against the bound table's PK schema.
 *
 * - Scalar PK → JSON array of scalars (`["a","b","c"]`).
 * - Composite PK → JSON array of objects.
 *
 * Validation is strict — no type coercion. Marks the param so
 * {@link discoverActions} can infer the action's `level` as `'rows'`.
 *
 * In `'rows'` skip mode the resolved value reflects the gate interceptor's
 * filtered subset (the cached PK slot is overwritten in place); see
 * {@link dbActionPksSlot} for precedence details.
 */
export function DbActionPKs(): ParameterDecorator {
  return createPkParamDecorator("pks");
}
