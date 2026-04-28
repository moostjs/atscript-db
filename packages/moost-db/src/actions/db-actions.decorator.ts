import { getMoostMate } from "moost";

import { MOOST_DB_ACTIONS, type TDbClassActionMeta } from "./keys";
import type { TDbActionsEntry, TDbActionsEntryUnpinned } from "./types";
import type { TDbActionLevel } from "@atscript/db";

/**
 * Declare class-level actions on a controller. Entries are flat dicts with
 * `processor: 'navigate' | 'custom' | 'backend'` matching the `/meta` wire
 * shape (see {@link TDbActionsEntry}). Each entry MUST specify `level`. Use
 * the level-pinned shortcuts (`@DbTableActions`, `@DbRowActions`,
 * `@DbRowsActions`) to avoid repeating `level`.
 *
 * The dictionary key serves as the action `name`. Entries do NOT bind any
 * HTTP route — the meta builder surfaces them in `/meta` only. For
 * `processor: 'backend'`, the dev-supplied `value` MUST point to a real
 * `@Post`-bound endpoint accepting the level-determined body shape.
 *
 * Multiple `@DbActions` (and shortcut) decorators on the same class
 * accumulate.
 */
export function DbActions(dict: Record<string, TDbActionsEntry>): ClassDecorator {
  return classLevelActions(dict);
}

/** Sugar for `@DbActions` with `level: 'table'` injected into each entry. */
export function DbTableActions(dict: Record<string, TDbActionsEntryUnpinned>): ClassDecorator {
  return classLevelActions(dict, "table");
}

/** Sugar for `@DbActions` with `level: 'row'` injected into each entry. */
export function DbRowActions(dict: Record<string, TDbActionsEntryUnpinned>): ClassDecorator {
  return classLevelActions(dict, "row");
}

/** Sugar for `@DbActions` with `level: 'rows'` injected into each entry. */
export function DbRowsActions(dict: Record<string, TDbActionsEntryUnpinned>): ClassDecorator {
  return classLevelActions(dict, "rows");
}

function classLevelActions(
  dict: Record<string, TDbActionsEntry | TDbActionsEntryUnpinned>,
  forcedLevel?: TDbActionLevel,
): ClassDecorator {
  const entries: TDbClassActionMeta[] = [];
  for (const [name, entry] of Object.entries(dict)) {
    entries.push({ name, entry: entry as TDbActionsEntry, forcedLevel });
  }
  const mate = getMoostMate();
  return mate.decorate((current) => {
    const meta = current as { [MOOST_DB_ACTIONS]?: TDbClassActionMeta[] };
    const existing = meta[MOOST_DB_ACTIONS] ?? [];
    return {
      ...current,
      [MOOST_DB_ACTIONS]: [...existing, ...entries],
    } as typeof current;
  }) as ClassDecorator;
}
