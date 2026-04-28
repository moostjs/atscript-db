import { useBody } from "@wooksjs/http-body";
import { HttpError } from "@moostjs/event-http";
import { ApplyDecorators, Resolve, getMoostMate, useControllerContext } from "moost";

import { MOOST_DB_ACTION_PARAM, type TDbActionParamKind } from "./keys";
import type { PkValidationSource } from "./pk-validation";

/**
 * Extract the PK validation source from a controller instance. Looks for
 * `readable` (set by {@link AsDbReadableController}) or `table` (set by
 * {@link AsDbController}).
 *
 * If the controller has no typed table attached (e.g. a value-help
 * controller, or a plain Moost controller without `@TableController`),
 * throws an HTTP 500 — this is a **server misconfiguration**, not a client
 * error. The body parser has nothing to validate against, so the request
 * cannot proceed. Use `@Body()` and parse the PK manually if you need to
 * accept PK-shaped bodies on a controller without an attached table.
 */
export function resolvePkSource(controller: unknown): PkValidationSource {
  const c = controller as { readable?: unknown; table?: unknown };
  const candidate = c.readable ?? c.table;
  if (!isPkValidationSource(candidate)) {
    throw new HttpError(
      500,
      "@DbActionPK/@DbActionPKs requires a controller with an attached table " +
        "(via @TableController / @ReadableController). Use @Body() instead if " +
        "your controller has no typed table.",
    );
  }
  return candidate;
}

function isPkValidationSource(value: unknown): value is PkValidationSource {
  if (!value || typeof value !== "object") return false;
  const v = value as { primaryKeys?: unknown; fieldDescriptors?: unknown };
  return Array.isArray(v.primaryKeys) && Array.isArray(v.fieldDescriptors);
}

/**
 * Build a parameter decorator that parses the JSON request body, validates
 * it against the bound table's PK schema with `validate`, and tags the param
 * so {@link discoverActions} can infer the action's `level`.
 */
export function createPkParamDecorator(
  kind: TDbActionParamKind,
  validate: (body: unknown, src: PkValidationSource) => void,
  resolverName: string,
): ParameterDecorator {
  const mate = getMoostMate();
  return ApplyDecorators(
    mate.decorate(MOOST_DB_ACTION_PARAM, kind),
    Resolve(async () => {
      const body = await useBody().parseBody<unknown>();
      const ctrl = useControllerContext().getController();
      validate(body, resolvePkSource(ctrl));
      return body;
    }, resolverName),
  );
}
