import { Intercept, Pipe } from "moost";

import { getAtscriptDbMate } from "../mate";
import { isAsValueHelpControllerSubclass, valueHelpActionError } from "./controller-registry";
import {
  buildGateInterceptor,
  buildTargetInterceptor,
  buildThinInterceptor,
} from "./gate-interceptor";
import { markHandlerStartPipe } from "./handler-start";
import { WARN_PREFIX, mergeActionMeta } from "./keys";
import { scanParamLevel } from "./param-level";
import { actionPrepareInterceptor } from "./prepare-request";
import type { DbActionOpts, FlatKey, TDbActionDisabledVerdict, TOnDisabledRows } from "./types";

/**
 * Mark a controller method as a database action surfaced via `/meta`. Writes
 * `atscript_db_action` metadata and, for every `'row'` / `'rows'` action,
 * registers a Moost interceptor: the batch gate for a `@DbActionTarget()`
 * handler (since 0.1.147), the gate when `disabled` is set, else the
 * bound-table injector that also verifies the ids against the controller's
 * row overlay (since 0.1.143). Either first awaits the controller's
 * `prepareRequest({ endpoint: "action", action })` when it defines one —
 * before any id is validated or row loaded; a `'table'`-level action on an
 * `AsReadableController` subclass gets an interceptor for that alone
 * (since 0.1.143). Stacking two `@DbAction` on the same method
 * is undefined and emits a warning. Throws on a value-help controller
 * (since 0.1.143 — value-help controllers do not support actions).
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
  const mate = getAtscriptDbMate();
  return ((target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    // Read before mate.decorate so mergeActionMeta doesn't overwrite the prior name.
    const priorName = mate.read(target, propertyKey as string)?.atscript_db_action?.name;
    if (priorName) {
      // eslint-disable-next-line no-console
      console.warn(
        `${WARN_PREFIX} stacking @DbAction on the same method is undefined; declare one per method. ` +
          `Detected: "${priorName}" and "${name}".`,
      );
    }

    mate.decorate((current) => ({
      ...current,
      atscript_db_action: mergeActionMeta(current, {
        name,
        opts: opts as DbActionOpts,
      }),
    }))(target, propertyKey, descriptor);

    // Value-help controllers don't surface actions — and the `@Post` route
    // would run ungated — so an action there is a hard error.
    const ctor = typeof target === "function" ? target : target.constructor;
    if (isAsValueHelpControllerSubclass(ctor)) {
      throw valueHelpActionError(ctor.name, [name]);
    }

    // Marks the moment the handler starts (every argument resolved): a
    // query target counts a batch as run only from there.
    Pipe(markHandlerStartPipe)(target, propertyKey, descriptor);

    const merged = mate.read(target, propertyKey as string);
    const scan = scanParamLevel(merged?.params ?? []);
    const rawOpts = opts as {
      disabled?: unknown;
      onDisabledRows?: TOnDisabledRows;
      table?: unknown;
    };
    const hasDisabled = typeof rawOpts.disabled === "function";

    if (scan.hasTarget && scan.level === "rows") {
      // `@DbActionTarget()` (since 0.1.147): the target is gated batch by batch.
      Intercept(
        buildTargetInterceptor({
          action: name,
          disabled: hasDisabled
            ? (rawOpts.disabled as (rows: unknown[]) => TDbActionDisabledVerdict[])
            : undefined,
          table: rawOpts.table,
        }),
      )(target, propertyKey, descriptor);
    } else if (hasDisabled && (scan.level === "row" || scan.level === "rows")) {
      const def = buildGateInterceptor({
        action: name,
        level: scan.level,
        disabled: rawOpts.disabled as (rows: unknown[]) => TDbActionDisabledVerdict[],
        onDisabledRows: rawOpts.onDisabledRows ?? "reject",
        table: rawOpts.table,
      });
      Intercept(def)(target, propertyKey, descriptor);
    } else if (scan.level !== "table" || scan.hasRowParam) {
      const scope =
        scan.level === "table"
          ? undefined
          : {
              action: name,
              level: scan.level,
              onDisabledRows: rawOpts.onDisabledRows ?? "reject",
            };
      Intercept(buildThinInterceptor({ table: rawOpts.table, scope }))(
        target,
        propertyKey,
        descriptor,
      );
    } else if (typeof (target as { parseRequest?: unknown }).parseRequest === "function") {
      // An `AsReadableController` subclass (the prototype chain is fixed, so
      // only these can carry `prepareRequest`); the interceptor returns
      // without awaiting when none is defined.
      Intercept(actionPrepareInterceptor)(target, propertyKey, descriptor);
    }

    return descriptor;
  }) as MethodDecorator;
}
