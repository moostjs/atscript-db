import { createPkParamDecorator } from "./pk-source";
import { validateSinglePk } from "./pk-validation";

/**
 * Parameter resolver that reads the primary key from the JSON request body
 * and validates it against the bound table's PK schema.
 *
 * - Single-field PK → JSON-encoded scalar (`"abc"`, `42`, `true`).
 * - Composite PK → JSON object with all PK fields.
 *
 * Validation is strict — no type coercion. Mismatches throw a
 * `ValidatorError` which the existing validation interceptor surfaces as
 * HTTP 400 with the same envelope as DTO failures.
 *
 * Marks the param so {@link discoverActions} can infer the action's `level`
 * as `'row'`.
 */
export function DbActionPK(): ParameterDecorator {
  return createPkParamDecorator("pk", validateSinglePk, "dbActionPk");
}
