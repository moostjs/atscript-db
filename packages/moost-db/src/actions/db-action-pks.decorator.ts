import { createPkParamDecorator } from "./pk-source";
import { validateMultiPk } from "./pk-validation";

/**
 * Parameter resolver that reads a JSON array of primary keys from the request
 * body and validates each entry against the bound table's PK schema.
 *
 * - Scalar PK → JSON array of scalars (`["a","b","c"]`).
 * - Composite PK → JSON array of objects.
 *
 * Validation is strict — no type coercion. Marks the param so
 * {@link discoverActions} can infer the action's `level` as `'rows'`.
 */
export function DbActionPKs(): ParameterDecorator {
  return createPkParamDecorator("pks", validateMultiPk, "dbActionPks");
}
