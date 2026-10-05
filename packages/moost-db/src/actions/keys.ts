import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import type { TDbRequestEndpoint } from "../as-readable.controller";
import type { TDbDecorationsMeta } from "../decorations/db-decorations.decorator";
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

/**
 * Class-level entry written by `@DbActionsFrom(source, opts)` (since
 * 0.1.147): a controller whose row-level actions this controller delegates.
 */
export interface TDbActionsFromMeta {
  /** Lazy reference to the source controller class. */
  source: () => Function;
  /** Source identification field → path in this controller's rows. */
  idMap?: Record<string, string>;
  /** Subset of the source's row / rows-level action names (default: all). */
  actions?: readonly string[];
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
    atscript_db_endpoint?: TDbRequestEndpoint;
    atscript_db_actions_from?: TDbActionsFromMeta[];
    atscript_db_decorations?: TDbDecorationsMeta;
  }
  interface TMoostParamsMetadata {
    atscript_db_action_param?: TDbActionParamKind;
    atscript_db_action_row?: TDbActionRowMarker;
    atscript_db_action_rows?: TDbActionRowMarker;
    atscript_db_action_input_form?: TDbActionInputFormMeta;
    atscript_db_action_target?: true;
    atscript_type?: TAtscriptAnnotatedType;
  }
}
