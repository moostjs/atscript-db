import { Post } from "@moostjs/event-http";
import { getMoostMate } from "moost";

import { DbEndpoint } from "../db-endpoint";
import { getAtscriptDbMate } from "../mate";
import { isAsValueHelpControllerSubclass } from "./controller-registry";
import { DELEGATED_QUERY_ROUTE } from "./delegation";
import { WARN_PREFIX, type TDbActionsFromMeta } from "./keys";

/** The `AsDbReadableController` method serving `POST {prefix}/delegated-actions/:name`. */
const DELEGATED_HANDLER = "runDelegatedOnQuery";

/**
 * Routes `POST {prefix}/delegated-actions/:name` on a class declaring
 * `@DbActionsFrom` (once; inherited by its subclasses) — other controllers
 * never get the route.
 */
function routeDelegatedActions(target: Function): void {
  const proto = target.prototype as Record<string, unknown>;
  if (typeof proto[DELEGATED_HANDLER] !== "function") return; // not a readable controller
  if (getMoostMate().read(proto, DELEGATED_HANDLER)?.handlers?.length) return;
  let descriptor: PropertyDescriptor | undefined;
  for (let p: object | null = proto; p && !descriptor; p = Object.getPrototypeOf(p)) {
    descriptor = Object.getOwnPropertyDescriptor(p, DELEGATED_HANDLER);
  }
  Post(`${DELEGATED_QUERY_ROUTE}/:name`)(proto, DELEGATED_HANDLER, descriptor!);
  DbEndpoint("delegatedAction")(proto, DELEGATED_HANDLER, descriptor!);
}

/** Options of {@link DbActionsFrom}. @since 0.1.147 */
export interface TDbActionsFromOpts {
  /**
   * Source identification field → the path in THIS controller's rows that
   * carries its value. Its keys must be exactly one identification of the
   * source (its primary key or a unique index). Default: derived from the
   * view definition — the view column that plainly maps each of the
   * source's `preferredId` fields. Required when this controller is not
   * bound to a view.
   */
  idMap?: Record<string, string>;
  /** The source's row / rows-level actions to delegate. Default: all of them. */
  actions?: readonly string[];
}

/**
 * Lists another controller's row / rows-level actions on THIS controller —
 * typically a `@ViewController` over the table whose actions the view's
 * rows stand for (since 0.1.147). The actions stay the source's: its route
 * runs them (`value`), its gate, permissions, `actionRowScope` and
 * `disabled` decide; the view only maps its rows to source ids.
 *
 * - `/meta.actions` lists them with `owner` (the source's base path) and,
 *   when the ids are renamed, `idMap`; forms come from the source
 *   (`formUrl`).
 * - `$actions` on the view's rows carries the source's verdict for the row
 *   each view row maps to — what the source's own `GET /meta/actions/:id`
 *   answers for it.
 * - `GET /meta/actions/:id` on the view answers them when the source id is
 *   the view id renamed (`idMap` paths ⊆ the id used).
 * - A source action declaring `queryTarget` also takes a query target on the
 *   VIEW (`queryTarget.url`): the view resolves "every view row matching the
 *   query" under its own read scope, maps the rows to source ids and runs the
 *   source's action route on them in batches — the source re-checks every
 *   batch.
 *
 * Repeatable (several sources, listed in declaration order). The source is
 * referenced lazily (no import cycles between controllers) and must be
 * registered with the app. Only a
 * controller declaring it gets the `POST {prefix}/delegated-actions/:name`
 * route (subclasses inherit it).
 *
 * ```ts
 * @ViewController(IssueBoard)
 * @DbActionsFrom(() => IssueController)                       // id → id
 * export class IssueBoardController extends AsDbReadableController<typeof IssueBoard> {}
 *
 * @DbActionsFrom(() => IssueController, { idMap: { id: "issueId" }, actions: ["close"] })
 * ```
 *
 * @since 0.1.147
 */
export function DbActionsFrom(
  source: () => Function,
  opts: TDbActionsFromOpts = {},
): ClassDecorator {
  const entry: TDbActionsFromMeta = { source, idMap: opts.idMap, actions: opts.actions };
  // Class decorators apply bottom-up: prepending keeps the declaration order
  // (the top `@DbActionsFrom` first).
  const decorate = getAtscriptDbMate().decorate((current) => ({
    ...current,
    atscript_db_actions_from: [entry, ...(current.atscript_db_actions_from ?? [])],
  })) as ClassDecorator;
  return (target) => {
    if (isAsValueHelpControllerSubclass(target)) {
      throw new Error(
        `${WARN_PREFIX} ${target.name} is a value-help controller — @DbActionsFrom is not supported there.`,
      );
    }
    const out = decorate(target);
    routeDelegatedActions(target);
    return out;
  };
}
