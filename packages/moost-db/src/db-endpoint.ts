import { getAtscriptDbMate } from "./mate";
import type { TDbRequestEndpoint } from "./as-readable.controller";

/**
 * Tags a framework handler whose authorization is delegated to the
 * controller's `prepareRequest` (it runs first with `endpoint`), so a
 * permission layer can recognise it without knowing its method name.
 * Internal — moost-db tags its own handlers.
 */
export function DbEndpoint(endpoint: TDbRequestEndpoint): MethodDecorator {
  return getAtscriptDbMate().decorate("atscript_db_endpoint", endpoint);
}

/**
 * The `prepareRequest` endpoint a controller handler delegates its
 * authorization to (since 0.1.145) — `undefined` for a handler that is
 * authorized on its own like any other route. `target` is the controller
 * instance or class; the tag is inherited through the class chain (a
 * subclass override of a tagged handler keeps it). Today only
 * `GET /meta/actions/:id` and `/meta/actions?…` are tagged
 * (`"availableActions"`).
 *
 * ```ts
 * const endpoint = getDbEndpoint(controller, methodName);
 * if (endpoint) return; // prepareRequest({ endpoint }) authorizes this call
 * ```
 */
export function getDbEndpoint(
  target: object,
  method: string | symbol,
): TDbRequestEndpoint | undefined {
  const mate = getAtscriptDbMate();
  let proto: object | null =
    typeof target === "function" ? (target as Function).prototype : Object.getPrototypeOf(target);
  for (; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    const endpoint = mate.read(proto, method as string)?.atscript_db_endpoint;
    if (endpoint) return endpoint;
  }
  return undefined;
}
