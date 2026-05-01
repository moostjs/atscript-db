import { createIdParamDecorator } from "./id-source";

/**
 * Parameter resolver that reads a row identifier from the JSON request body
 * and validates it against the bound table's legitimate identifiers.
 *
 * Body shape is always a JSON object — no scalar form. The object's key set
 * MUST exactly match one of the table's legitimate identifications:
 *
 * - Single-field PK → `{ id: "abc" }` (or whatever the PK prop is named).
 * - Composite PK → `{ tenantId: "...", userId: "..." }`.
 * - Single-field unique index → `{ slug: "alpha" }`.
 * - Compound unique index → `{ tenantId: "...", slug: "..." }`.
 *
 * Strict — unknown fields are rejected, no type coercion. Mismatches throw a
 * `ValidatorError` which the existing validation interceptor surfaces as
 * HTTP 400 with the same envelope as DTO failures.
 *
 * Marks the param so {@link discoverActions} can infer the action's `level`
 * as `'row'`.
 *
 * Implementation note: the resolver is a thin reader of the cached ID wook
 * — validation logic lives in the wook factory, which runs once per request
 * regardless of how many readers consume the value.
 */
export function DbActionID(): ParameterDecorator {
  return createIdParamDecorator("id");
}
