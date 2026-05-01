import { Intercept, getMoostMate } from "moost";

import { isAsValueHelpControllerSubclass } from "./controller-registry";
import { buildGateInterceptor, buildThinInterceptor } from "./gate-interceptor";
import { MOOST_DB_ACTION, WARN_PREFIX, mergeActionMeta, type TDbActionMeta } from "./keys";
import { scanParamLevel } from "./param-level";
import type { DbActionOpts } from "./types";

/**
 * Mark a controller method as a database action surfaced via `/meta`. Writes
 * `MOOST_DB_ACTION` metadata and registers a Moost interceptor when needed
 * (gate when `disabled` is set, thin bound-table injector when only
 * `@DbActionRow*` is present). Stacking two `@DbAction` on the same method
 * is undefined and emits a warning.
 */
export function DbAction<TRow = unknown>(
  name: string,
  opts: DbActionOpts<TRow> = {},
): MethodDecorator {
  const mate = getMoostMate();
  return ((target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    // Read before mate.decorate so mergeActionMeta doesn't overwrite the prior name.
    const existing = mate.read(target, propertyKey as string) as
      | { [MOOST_DB_ACTION]?: TDbActionMeta }
      | undefined;
    const priorName = existing?.[MOOST_DB_ACTION]?.name;
    if (priorName) {
      // eslint-disable-next-line no-console
      console.warn(
        `${WARN_PREFIX} stacking @DbAction on the same method is undefined; declare one per method. ` +
          `Detected: "${priorName}" and "${name}".`,
      );
    }

    mate.decorate((current) => {
      const meta = current as { [MOOST_DB_ACTION]?: TDbActionMeta };
      return {
        ...current,
        [MOOST_DB_ACTION]: mergeActionMeta(meta, {
          name,
          opts: opts as DbActionOpts,
        }),
      } as typeof current;
    })(target, propertyKey, descriptor);

    // Value-help controllers don't surface actions; skip interceptor registration.
    const ctor = typeof target === "function" ? target : target.constructor;
    if (isAsValueHelpControllerSubclass(ctor)) {
      return descriptor;
    }

    const merged = mate.read(target, propertyKey as string) as
      | { params?: Array<Record<string, unknown>> }
      | undefined;
    const scan = scanParamLevel(merged?.params ?? []);
    const hasDisabled = !!opts.disabled;

    if (hasDisabled && (scan.level === "row" || scan.level === "rows")) {
      const def = buildGateInterceptor({
        action: name,
        level: scan.level,
        disabled: opts.disabled as (row: unknown) => boolean,
        onDisabledRows: opts.onDisabledRows ?? "reject",
        table: opts.table,
      });
      Intercept(def)(target, propertyKey, descriptor);
    } else if (scan.hasRowParam) {
      Intercept(buildThinInterceptor({ table: opts.table }))(target, propertyKey, descriptor);
    }

    return descriptor;
  }) as MethodDecorator;
}
