import { Intercept, getMoostMate } from "moost";

import { isAsValueHelpControllerSubclass } from "./controller-registry";
import { buildGateInterceptor, buildThinInterceptor } from "./gate-interceptor";
import { MOOST_DB_ACTION, WARN_PREFIX, mergeActionMeta, type TDbActionMeta } from "./keys";
import { scanParamLevel } from "./param-level";
import type { DbActionOpts, FlatKey, TOnDisabledRows } from "./types";

/**
 * Mark a controller method as a database action surfaced via `/meta`. Writes
 * `MOOST_DB_ACTION` metadata and registers a Moost interceptor when needed
 * (gate when `disabled` is set, thin bound-table injector when only
 * `@DbActionRow*` is present). Stacking two `@DbAction` on the same method
 * is undefined and emits a warning.
 *
 * Generic over `TRow` (annotate at the call site: `@DbAction<Order>(...)`)
 * and `R` (the literal `requiredFields` tuple, inferred via `const R`).
 * The `disabled` predicate's `rows` argument is type-narrowed to
 * `Pick<FlatOf<TRow>, R[number]>[]`.
 */
export function DbAction<TRow = unknown, const R extends readonly FlatKey<TRow>[] = []>(
  name: string,
  opts: DbActionOpts<TRow, R> = {} as DbActionOpts<TRow, R>,
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
    const rawOpts = opts as {
      disabled?: unknown;
      onDisabledRows?: TOnDisabledRows;
      table?: unknown;
    };
    const hasDisabled = typeof rawOpts.disabled === "function";

    if (hasDisabled && (scan.level === "row" || scan.level === "rows")) {
      const def = buildGateInterceptor({
        action: name,
        level: scan.level,
        disabled: rawOpts.disabled as (rows: unknown[]) => boolean[],
        onDisabledRows: rawOpts.onDisabledRows ?? "reject",
        table: rawOpts.table,
      });
      Intercept(def)(target, propertyKey, descriptor);
    } else if (scan.hasRowParam) {
      Intercept(buildThinInterceptor({ table: rawOpts.table }))(target, propertyKey, descriptor);
    }

    return descriptor;
  }) as MethodDecorator;
}
