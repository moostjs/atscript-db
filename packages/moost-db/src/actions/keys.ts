import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import type { DbActionOpts, TDbActionsEntry } from "./types";

/** Log-message prefix for warnings emitted from the actions subsystem. */
export const WARN_PREFIX = "[moost-db actions]";

type TDbActionRowMarker = true;

/** Stamped by `@InputForm(FormType)` — the compiled `.as` class + the wire name (`FormType.name`). */
export interface TDbActionInputFormMeta {
  type: TAtscriptAnnotatedType;
  name: string;
}

/** Method-level action metadata written by `@DbAction(name, opts)`. */
export interface TDbActionMeta {
  name: string;
  opts: DbActionOpts;
}

/** Class-level entry — a `TDbActionsEntry` plus its dictionary key. */
export interface TDbClassActionMeta {
  name: string;
  entry: TDbActionsEntry;
}

/** Param marker kind — informs level inference and ID-resolution shape. */
export type TDbActionParamKind = "id" | "ids";

/**
 * Shared method-decorator update used by `@DbAction` and `@DbActionDefault`:
 * read the existing `atscript_db_action` slot, merge the patch (later-applied
 * fields win), and write it back. `name` is empty until `@DbAction` provides
 * one — `discoverActions` warns and drops actions with no name.
 */
export function mergeActionMeta(
  current: { atscript_db_action?: TDbActionMeta },
  patch: { name?: string; opts: DbActionOpts },
): TDbActionMeta {
  const existing = current.atscript_db_action;
  return {
    name: patch.name ?? existing?.name ?? "",
    opts: { ...existing?.opts, ...patch.opts },
  };
}

declare module "moost" {
  interface TMoostMetadata {
    atscript_db_action?: TDbActionMeta;
    atscript_db_actions?: TDbClassActionMeta[];
    atscript_db_action_param?: TDbActionParamKind;
    atscript_db_action_row?: TDbActionRowMarker;
    atscript_db_action_rows?: TDbActionRowMarker;
  }
  interface TMoostParamsMetadata {
    atscript_db_action_param?: TDbActionParamKind;
    atscript_db_action_row?: TDbActionRowMarker;
    atscript_db_action_rows?: TDbActionRowMarker;
    atscript_db_action_input_form?: TDbActionInputFormMeta;
    atscript_type?: TAtscriptAnnotatedType;
  }
}
