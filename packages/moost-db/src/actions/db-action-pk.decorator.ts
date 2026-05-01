import { createPkParamDecorator } from "./pk-source";

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
 *
 * Implementation note: the resolver is a thin reader of the cached PK wook
 * — validation logic lives in the wook factory, which runs once per request
 * regardless of how many readers consume the value.
 */
export function DbActionPK(): ParameterDecorator {
  return createPkParamDecorator("pk");
}
