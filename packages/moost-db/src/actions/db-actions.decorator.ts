import { getAtscriptDbMate } from "../mate";
import type { TDbClassActionMeta } from "./keys";
import type { TDbActionsEntry, ValidatedDict, ValidatedUnpinnedDict } from "./types";
import type { TDbActionLevel } from "@atscript/db";

/**
 * Declare class-level actions on a controller. Entries are flat dicts with
 * `processor: 'navigate' | 'custom' | 'backend'` matching the `/meta` wire
 * shape (see {@link TDbActionsEntry}). Each entry MUST specify `level`. Use
 * the level-pinned shortcuts (`@DbTableActions`, `@DbRowActions`,
 * `@DbRowsActions`) to avoid repeating `level`.
 *
 * Generic over `TRow` (annotate at the call site: `@DbActions<Order>(...)`)
 * and `D` (the literal dict, captured via `const D`). Each entry's
 * `disabled` predicate is type-narrowed by its own `requiredFields` literal.
 *
 * Multiple `@DbActions` (and shortcut) decorators on the same class
 * accumulate.
 */
export function DbActions<TRow = unknown, const D extends Record<string, unknown> = {}>(
  dict: D & ValidatedDict<TRow, D>,
): ClassDecorator {
  return classLevelActions(dict as Record<string, TDbActionsEntry>);
}

/** Sugar for `@DbActions` with `level: 'table'` injected into each entry. */
export function DbTableActions<TRow = unknown, const D extends Record<string, unknown> = {}>(
  dict: D & ValidatedUnpinnedDict<TRow, D>,
): ClassDecorator {
  return classLevelActions(dict as Record<string, TDbActionsEntry>, "table");
}

/** Sugar for `@DbActions` with `level: 'row'` injected into each entry. */
export function DbRowActions<TRow = unknown, const D extends Record<string, unknown> = {}>(
  dict: D & ValidatedUnpinnedDict<TRow, D>,
): ClassDecorator {
  return classLevelActions(dict as Record<string, TDbActionsEntry>, "row");
}

/** Sugar for `@DbActions` with `level: 'rows'` injected into each entry. */
export function DbRowsActions<TRow = unknown, const D extends Record<string, unknown> = {}>(
  dict: D & ValidatedUnpinnedDict<TRow, D>,
): ClassDecorator {
  return classLevelActions(dict as Record<string, TDbActionsEntry>, "rows");
}

function classLevelActions(
  dict: Record<string, TDbActionsEntry>,
  forcedLevel?: TDbActionLevel,
): ClassDecorator {
  const entries: TDbClassActionMeta[] = [];
  for (const [name, entry] of Object.entries(dict)) {
    const merged = (forcedLevel ? { ...entry, level: forcedLevel } : entry) as TDbActionsEntry;
    entries.push({ name, entry: merged });
  }
  return getAtscriptDbMate().decorate((current) => ({
    ...current,
    atscript_db_actions: [...(current.atscript_db_actions ?? []), ...entries],
  })) as ClassDecorator;
}
