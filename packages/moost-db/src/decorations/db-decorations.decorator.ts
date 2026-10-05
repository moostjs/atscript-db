import {
  isAnnotatedType,
  type TAtscriptAnnotatedType,
  type TAtscriptDataType,
} from "@atscript/typescript/utils";

import { isAsValueHelpControllerSubclass } from "../actions/controller-registry";
import { getAtscriptDbMate } from "../mate";

/** Options of {@link DbDecorations}. @since 0.1.148 */
export interface TDbDecorationsOpts<D = Record<string, unknown>> {
  /**
   * Per decoration key, the bound readable's field paths `decorateRows` reads
   * to compute it. Those paths are selected (and kept visible) automatically
   * and stripped from the response unless the client selected them. A
   * decoration that reveals a field's data MUST list it: the decoration is
   * then served — and listed in `/meta` — only while that field is visible.
   */
  requires?: { [K in keyof D & string]?: readonly string[] };
}

/** Class metadata written by {@link DbDecorations}. */
export interface TDbDecorationsMeta {
  /** The declared interface (a plain object type, no `@db.table` / `@db.view`). */
  type: TAtscriptAnnotatedType;
  /** Decoration key → the readable's field paths it reads. */
  requires: Readonly<Record<string, readonly string[]>>;
}

/**
 * Declares display-only (decoration) fields of a table or view controller —
 * values `decorateRows` computes and attaches to rows (since 0.1.148).
 *
 * `type` is a plain atscript interface (no `@db.table` / `@db.view`) whose
 * top-level props are the decorations: their `@meta.label`, `@expect.*` and
 * `@ui.*` annotations travel in `/meta.decorations`, each key is listed in
 * `/meta.fields` with `decoration: true`, and a client may name it in
 * `$select`. A decoration is never filterable, sortable or groupable, and it
 * is not part of `/meta.type` (forms and write validation never see it).
 *
 * ```ts
 * @TableController(TicketTable)
 * @DbDecorations(TicketDecorations, { requires: { ownerName: ["ownerId"] } })
 * export class TicketsController extends AsDbController<typeof TicketTable> {
 *   protected async decorateRows(rows: Record<string, unknown>[], ctx: TDbDecorateContext) {
 *     if (ctx.decorations.has("ownerName")) {
 *       // read rows[i].ownerId, set rows[i].ownerName
 *     }
 *   }
 * }
 * ```
 *
 * Validated once per class at first use (a `[moost-db]` error): the type is an
 * object interface; keys are top-level identifiers that collide with no field
 * or relation of the readable; every `requires` path is an own, readable
 * (not `@db.writeOnly`) field. Inherited under `@Inherit()`. Not supported on
 * value-help controllers.
 *
 * @since 0.1.148
 */
export function DbDecorations<D extends TAtscriptAnnotatedType>(
  type: D,
  opts: TDbDecorationsOpts<TAtscriptDataType<D>> = {},
): ClassDecorator {
  if (!isAnnotatedType(type)) {
    throw new Error("[moost-db] @DbDecorations: expects a compiled atscript interface");
  }
  const meta: TDbDecorationsMeta = {
    type,
    requires: Object.fromEntries(
      Object.entries((opts.requires ?? {}) as Record<string, readonly string[] | undefined>).map(
        ([key, paths]) => [key, [...(paths ?? [])]],
      ),
    ),
  };
  const decorate = getAtscriptDbMate().decorate("atscript_db_decorations", meta) as ClassDecorator;
  return (target) => {
    if (isAsValueHelpControllerSubclass(target)) {
      throw new Error(
        `[moost-db] ${target.name} is a value-help controller — @DbDecorations is not supported there.`,
      );
    }
    return decorate(target);
  };
}
