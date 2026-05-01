import { createIdParamDecorator } from "./id-source";

/**
 * Parameter resolver that reads a JSON array of row identifiers from the
 * request body and validates each entry against the bound table.
 *
 * Body shape is always a JSON array of objects — no scalar form. Each
 * element's key set MUST exactly match one of the table's legitimate
 * identifications (PK or any unique index). Elements MAY mix shapes:
 * `[{ id: "1" }, { slug: "alpha" }]` is valid when both `id` is the PK
 * and `slug` is a unique index.
 *
 * Strict — unknown fields are rejected, no type coercion. Marks the param
 * so {@link discoverActions} can infer the action's `level` as `'rows'`.
 *
 * In `'rows'` skip mode the resolved value reflects the gate interceptor's
 * filtered subset (the cached ID slot is overwritten in place); see
 * {@link dbActionIdsSlot} for precedence details.
 */
export function DbActionIDs(): ParameterDecorator {
  return createIdParamDecorator("ids");
}
