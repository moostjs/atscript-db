import { getAtscriptDbMate } from "../mate";
import { mergeActionMeta } from "./keys";

/**
 * Sugar that flips `default: true` on the same method's `@DbAction` metadata.
 * Equivalent to passing `opts.default = true`. Decorator order does not matter.
 */
export function DbActionDefault(): MethodDecorator {
  return getAtscriptDbMate().decorate((current) => ({
    ...current,
    atscript_db_action: mergeActionMeta(current, { opts: { default: true } }),
  })) as MethodDecorator;
}
