import type { TExistingTableOption, TTableOptionDiff } from "../types";

/**
 * Computes the difference between desired and existing table options.
 *
 * Options present in desired but absent from existing are ignored (initial state).
 * Options present in existing but absent from desired are ignored (sticky options).
 * Only value changes on matching keys are tracked.
 *
 * @param desired - Options from Atscript annotations (via adapter.getDesiredTableOptions()).
 * @param existing - Options from DB introspection or snapshot fallback.
 * @param destructiveKeys - Option keys where a value change requires table recreation.
 */
export function computeTableOptionDiff(
  desired: readonly TExistingTableOption[],
  existing: readonly TExistingTableOption[],
  destructiveKeys?: ReadonlySet<string>,
): TTableOptionDiff {
  const existingByKey = new Map(existing.map((o) => [o.key, o.value]));
  const changed: TTableOptionDiff["changed"] = [];

  for (const opt of desired) {
    const existingValue = existingByKey.get(opt.key);
    if (existingValue !== undefined && existingValue !== opt.value) {
      changed.push({
        key: opt.key,
        oldValue: existingValue,
        newValue: opt.value,
        destructive: destructiveKeys?.has(opt.key) ?? false,
      });
    }
  }

  return { changed };
}
