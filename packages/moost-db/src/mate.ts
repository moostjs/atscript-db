import type { AtscriptDbReadable } from "@atscript/db";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import { type Mate, type TMateParamMeta, type TMoostMetadata, getMoostMate } from "moost";

import type {
  TDbActionInputFormMeta,
  TDbActionMeta,
  TDbActionParamKind,
  TDbClassActionMeta,
} from "./actions/keys";

/**
 * Class-level readable-binding descriptor written by `@TableController` /
 * `@ReadableController` / `@ViewController`. One uniform `resolve()` backs
 * both the DI provide factory and the base controller's
 * `super(undefined, app)` fallback; `model` additionally feeds
 * `assertExposed()`.
 */
export interface TReadableBindingMeta {
  /**
   * The bound model token. Present for the token form (the token itself) and
   * the instance form (`readable.type`); unknown for lazy factories until
   * resolved.
   */
  model?: TAtscriptAnnotatedType;
  /** Resolves the readable — lazily for token/factory, identity for instance. */
  resolve: () => AtscriptDbReadable<any>;
}

/**
 * Class- and method-level metadata written by `@atscript/moost-db`'s
 * decorators (`@DbAction`, `@DbActionDefault`, `@DbActions`,
 * `@DbTableActions`, `@DbRowActions`, `@DbRowsActions`).
 *
 * The keys are intentionally kept identical to the underlying
 * mate-storage keys (`atscript_db_*`) so the same shape applies whether
 * the consumer reads via {@link getAtscriptDbMate} or pokes the raw
 * `getMoostMate()` instance directly. End-users never need to type the
 * magic strings — `mate.read(...)?.atscript_db_action` is fully typed.
 */
export interface AtscriptDbMeta {
  /** Method-level — written by `@DbAction(name, opts)` / `@DbActionDefault()`. */
  atscript_db_action?: TDbActionMeta;
  /** Class-level — written by `@DbActions` and the level-pinned shortcuts. Decorators accumulate into the array. */
  atscript_db_actions?: TDbClassActionMeta[];
  /** Param-level marker — written by `@DbActionID()` / `@DbActionIDs()`. Drives action-level inference. */
  atscript_db_action_param?: TDbActionParamKind;
  /** Param-level marker — written by `@DbActionRow()`. */
  atscript_db_action_row?: true;
  /** Param-level marker — written by `@DbActionRows()`. */
  atscript_db_action_rows?: true;
  /** Class-level — written by `@TableController` / `@ReadableController` / `@ViewController`. */
  atscript_db_readable_binding?: TReadableBindingMeta;
}

/**
 * Param-level metadata written by `@atscript/moost-db`'s param
 * decorators. A superset of {@link AtscriptDbMeta}'s param-level keys
 * plus the `@InputForm()`-specific entries.
 */
export interface AtscriptDbParamsMeta {
  /** Param-level — written by `@DbActionID()` / `@DbActionIDs()`. */
  atscript_db_action_param?: TDbActionParamKind;
  /** Param-level marker — written by `@DbActionRow()`. */
  atscript_db_action_row?: true;
  /** Param-level marker — written by `@DbActionRows()`. */
  atscript_db_action_rows?: true;
  /**
   * Param-level — written by `@InputForm(FormType)`. Carries the
   * compiled `.as` class plus its `.name` so `discoverActions` can both
   * emit `inputForm` on `/meta` and register the type in the controller's
   * form registry for `GET /meta/form/:name`.
   */
  atscript_db_action_input_form?: TDbActionInputFormMeta;
  /**
   * Param-level — written by `@InputForm(FormType)` alongside
   * `atscript_db_action_input_form`. Holds just the type ref so a generic
   * atscript-aware Moost pipe (installed globally via
   * `app.applyGlobalPipes(...)` or scoped via `@Pipe(...)`) can validate
   * the resolved value without knowing about the moost-db-specific key.
   */
  atscript_type?: TAtscriptAnnotatedType;
}

/**
 * The fully-typed {@link Mate} instance shared across the moost
 * metadata workspace, narrowed to the keys that
 * `@atscript/moost-db` writes.
 *
 * Class- and prop-meta storage mirror the same shape; param-meta
 * storage uses {@link AtscriptDbParamsMeta}.
 */
export type AtscriptDbMate = Mate<
  TMoostMetadata &
    AtscriptDbMeta & {
      params: (TMateParamMeta & AtscriptDbParamsMeta)[];
    },
  TMoostMetadata &
    AtscriptDbMeta & {
      params: (TMateParamMeta & AtscriptDbParamsMeta)[];
    }
>;

/**
 * Returns the shared moost-mate instance, typed against every key that
 * `@atscript/moost-db` writes (see {@link AtscriptDbMeta} +
 * {@link AtscriptDbParamsMeta}).
 *
 * Prefer this over `getMoostMate()` from `moost` whenever you need to
 * read moost-db metadata — callers no longer have to retype the
 * `atscript_db_*` magic strings or hand-cast the result.
 *
 * @example
 * ```ts
 * import { getAtscriptDbMate } from "@atscript/moost-db";
 *
 * const mate = getAtscriptDbMate();
 * const meta = mate.read(controllerCtor.prototype, methodName);
 * const dbAction = meta?.atscript_db_action;       // TDbActionMeta | undefined
 * const inputForm = meta?.params?.[0]?.atscript_db_action_input_form;
 * ```
 */
export function getAtscriptDbMate(): AtscriptDbMate {
  return getMoostMate<AtscriptDbMeta, AtscriptDbMeta, AtscriptDbParamsMeta>() as AtscriptDbMate;
}
