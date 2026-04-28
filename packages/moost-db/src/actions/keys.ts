import type { TDbActionLevel } from "@atscript/db";

import type { DbActionOpts, TDbActionsEntry } from "./types";

/** Method-level metadata key — written by `@DbAction(name, opts)`. */
export const MOOST_DB_ACTION = "atscript_db_action";
/** Class-level metadata key — written by `@DbActions` and the level-pinned shortcuts. Stored as an array; decorators accumulate. */
export const MOOST_DB_ACTIONS = "atscript_db_actions";
/** Param-level metadata key — written by `@DbActionPK()` / `@DbActionPKs()`. Drives level inference. */
export const MOOST_DB_ACTION_PARAM = "atscript_db_action_param";

/** Method-level action metadata written by `@DbAction(name, opts)`. */
export interface TDbActionMeta {
  name: string;
  opts: DbActionOpts;
}

/** Class-level entry — a `TDbActionsEntry` plus its dictionary key. */
export interface TDbClassActionMeta {
  name: string;
  entry: TDbActionsEntry;
  /** Set by the level-pinned shortcuts; the dict-supplied `level` wins otherwise. */
  forcedLevel?: TDbActionLevel;
}

/** Param marker kind — informs level inference and PK-resolution shape. */
export type TDbActionParamKind = "pk" | "pks";

/**
 * Shared method-decorator update used by `@DbAction` and `@DbActionDefault`:
 * read the existing `MOOST_DB_ACTION` slot, merge the patch (later-applied
 * fields win), and write it back. `name` is empty until `@DbAction` provides
 * one — `discoverActions` warns and drops actions with no name.
 */
export function mergeActionMeta(
  current: { [MOOST_DB_ACTION]?: TDbActionMeta },
  patch: { name?: string; opts: DbActionOpts },
): TDbActionMeta {
  const existing = current[MOOST_DB_ACTION];
  return {
    name: patch.name ?? existing?.name ?? "",
    opts: { ...existing?.opts, ...patch.opts },
  };
}

declare module "moost" {
  interface TMoostMetadata {
    [MOOST_DB_ACTION]?: TDbActionMeta;
    [MOOST_DB_ACTIONS]?: TDbClassActionMeta[];
    [MOOST_DB_ACTION_PARAM]?: TDbActionParamKind;
  }
  interface TMoostParamsMetadata {
    [MOOST_DB_ACTION_PARAM]?: TDbActionParamKind;
  }
}
