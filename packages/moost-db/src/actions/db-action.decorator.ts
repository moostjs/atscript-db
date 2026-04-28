import { getMoostMate } from "moost";

import { MOOST_DB_ACTION, mergeActionMeta, type TDbActionMeta } from "./keys";
import type { DbActionOpts } from "./types";

/**
 * Mark a controller method as a database action surfaced via `/meta`.
 *
 * Metadata-only — pair with `@Post(...)` for Moost to bind the route. The
 * meta builder reads this metadata plus the bound POST path lazily and
 * emits the action with `processor: 'backend'`. Order vs.
 * `@DbActionDefault()` does not matter — both merge into the same slot.
 *
 * @example
 * ```ts
 * @Post('actions/block')
 * @DbAction('block', { label: 'Block', icon: 'i-as-block', intent: 'negative' })
 * async blockUser(@DbActionPK() id: string) { ... }
 * ```
 */
export function DbAction(name: string, opts: DbActionOpts = {}): MethodDecorator {
  const mate = getMoostMate();
  return mate.decorate((current) => {
    const meta = current as { [MOOST_DB_ACTION]?: TDbActionMeta };
    return {
      ...current,
      [MOOST_DB_ACTION]: mergeActionMeta(meta, { name, opts }),
    } as typeof current;
  }) as MethodDecorator;
}
