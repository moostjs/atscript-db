import { getMoostMate } from "moost";

import { MOOST_DB_ACTION, mergeActionMeta, type TDbActionMeta } from "./keys";

/**
 * Sugar that flips `default: true` on the same method's `@DbAction` metadata.
 * Equivalent to passing `opts.default = true`. Decorator order does not matter.
 */
export function DbActionDefault(): MethodDecorator {
  const mate = getMoostMate();
  return mate.decorate((current) => {
    const meta = current as { [MOOST_DB_ACTION]?: TDbActionMeta };
    return {
      ...current,
      [MOOST_DB_ACTION]: mergeActionMeta(meta, { opts: { default: true } }),
    } as typeof current;
  }) as MethodDecorator;
}
