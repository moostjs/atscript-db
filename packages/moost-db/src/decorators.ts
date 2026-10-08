import type { AtscriptDbTable, AtscriptDbReadable } from "@atscript/db";
import { isAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import { Controller, Provide, ApplyDecorators, Inherit } from "moost";

import { getAtscriptDbMate, type TReadableBindingMeta } from "./mate";
import { resolveDbSpace } from "./db-space-registry";
import { designTimeHttpPath } from "./http-path-design-time";

/**
 * DI token under which the {@link AtscriptDbReadable} instance
 * is exposed to the readable controller's constructor via `@Inject`.
 */
export const READABLE_DEF = "__atscript_db_readable_def";

/**
 * DI token under which the {@link AtscriptDbTable} instance
 * is exposed to the controller's constructor via `@Inject`.
 * Points to the same token as READABLE_DEF for backward compatibility.
 */
export const TABLE_DEF = READABLE_DEF;

/**
 * Accepted binding forms for the controller decorators:
 * - a readable **instance** (`db.getTable(Model)`) — resolved eagerly, legacy form;
 * - a **lazy factory** (`() => db.getTable(Model)`) — resolved at first
 *   controller instantiation (during `app.init()`), so the space may be
 *   created after the controller module is imported;
 * - a **model token** (the compiled `.as` class) — resolved at instantiation
 *   against the ambient space registry (see `provideDbSpace`), honoring the
 *   model's `@db.space` annotation unless overridden via `options.space`.
 */
export type TReadableBinding<Readable> = Readable | (() => Readable) | TAtscriptAnnotatedType;

/** Options bag accepted as the decorators' second argument (or a plain prefix string). */
export interface TControllerBindingOptions {
  /** Route prefix override. Same meaning as the legacy string second argument. */
  prefix?: string;
  /**
   * Space name for the model-token form — overrides the model's `@db.space`
   * annotation. Ignored for instance/factory bindings.
   */
  space?: string;
  /**
   * Marks (`true`) or excludes (`false`) this controller as the one whose route
   * is published as the model's value-help path (`db.http.path`) when the same
   * model is served by several controllers in one app. A single `canonical: true`
   * mount wins; `canonical: false` mounts are never published; without a marker
   * the model's own `@db.http.path`-derived mount breaks ties, and any remaining
   * ambiguity leaves the path unset (with a boot warning). Parametric mounts
   * (`:param` / `*` segments) are never published.
   *
   * @since 0.1.150
   */
  canonical?: boolean;
}

function normalizeOptions(
  prefixOrOptions?: string | TControllerBindingOptions,
): TControllerBindingOptions {
  if (typeof prefixOrOptions === "string") {
    return { prefix: prefixOrOptions };
  }
  return prefixOrOptions ?? {};
}

/**
 * Builds the shared binding metadata for a decorator invocation: classifies
 * the binding form, computes the static route prefix, and packages a uniform
 * `resolve()` used by both the DI provide factory and the base controller's
 * `super(app)` fallback.
 */
function buildBinding(
  binding: TReadableBinding<AtscriptDbReadable<any>>,
  options: TControllerBindingOptions,
  decoratorName: string,
): { meta: TReadableBindingMeta; prefix: string } {
  const canonical = options.canonical;
  if (isAnnotatedType(binding)) {
    const model = binding;
    const space = options.space ?? (model.metadata.get("db.space") as string | undefined);
    // The design-time hint: moost-db mirrors the published path into the same
    // key at runtime, which must never feed back into a later decoration.
    const hinted = designTimeHttpPath(model);
    const prefix =
      options.prefix ||
      hinted ||
      (model.metadata.get("db.table") as string | undefined) ||
      (model.metadata.get("db.view") as string | undefined) ||
      (model as { id?: string }).id ||
      "";
    const prefixSource = options.prefix ? "option" : hinted ? "annotation" : "name";
    if (!prefix) {
      throw new Error(
        `[moost-db] @${decoratorName}: cannot derive a route prefix from the model token ` +
          `(no @db.http.path / @db.table / @db.view and no type id). Pass an explicit prefix.`,
      );
    }
    return {
      meta: {
        model,
        resolve: () => resolveDbSpace(space).get(model),
        prefix,
        prefixSource,
        canonical,
      },
      prefix,
    };
  }

  if (typeof binding === "function") {
    if (!options.prefix) {
      throw new Error(
        `[moost-db] @${decoratorName}: the lazy factory form needs an explicit route prefix ` +
          `(the readable is not created until app.init()). Pass a prefix, or use the model ` +
          `token form which derives it from @db.http.path / @db.table.`,
      );
    }
    return {
      meta: {
        resolve: binding as () => AtscriptDbReadable,
        prefix: options.prefix,
        prefixSource: "option",
        canonical,
      },
      prefix: options.prefix,
    };
  }

  const readable = binding;
  const hinted = designTimeHttpPath(readable.type as TAtscriptAnnotatedType);
  const prefix = options.prefix || hinted || readable.tableName;
  return {
    meta: {
      model: readable.type as TAtscriptAnnotatedType,
      resolve: () => readable,
      prefix,
      prefixSource: options.prefix ? "option" : hinted ? "annotation" : "name",
      canonical,
    },
    prefix,
  };
}

function bindReadableController(
  binding: TReadableBinding<AtscriptDbReadable<any>>,
  prefixOrOptions: string | TControllerBindingOptions | undefined,
  decoratorName: string,
): ClassDecorator {
  const { meta, prefix } = buildBinding(binding, normalizeOptions(prefixOrOptions), decoratorName);
  return ApplyDecorators(
    getAtscriptDbMate().decorate((classMeta) => {
      classMeta.atscript_db_readable_binding = meta;
      return classMeta;
    }),
    Provide(READABLE_DEF, () => meta.resolve()),
    Controller(prefix),
    Inherit(),
  );
}

/**
 * Combines the boilerplate needed to turn an {@link AsDbController}
 * subclass into a fully wired HTTP controller for a given `@db.table` model.
 *
 * Internally applies three decorators:
 * 1. **Provide** — registers the readable resolver under {@link TABLE_DEF}.
 * 2. **Controller** — registers the class as a Moost HTTP controller
 *    with an optional route prefix (defaults to `@db.http.path`, then the
 *    table name).
 * 3. **Inherit** — copies metadata (routes, guards, etc.) from the
 *    parent class so they stay active in the derived controller.
 *
 * All three binding forms are supported (see {@link TReadableBinding}):
 *
 * ```ts
 * ‎@TableController(User)                      // model token (preferred)
 * ‎@TableController(User, { space: "analytics" })
 * ‎@TableController(() => db.getTable(User), "users") // lazy factory
 * ‎@TableController(usersTable)                // instance (legacy)
 * export class UsersController extends AsDbController<typeof User> {}
 * ```
 *
 * Token and factory forms resolve lazily at first controller instantiation
 * (during `app.init()`), so the `DbSpace` does not have to exist when the
 * controller module is imported. For the token form, register the space with
 * `provideDbSpace(db)` before `app.init()`.
 *
 * @param binding Model token, lazy factory, or {@link AtscriptDbTable} instance.
 * @param prefixOrOptions Route prefix string, or {@link TControllerBindingOptions}.
 */
export const TableController = <Table extends AtscriptDbTable<any, any, any, any, any, any, any>>(
  binding: TReadableBinding<Table>,
  prefixOrOptions?: string | TControllerBindingOptions,
) => bindReadableController(binding, prefixOrOptions, "TableController");

/**
 * Combines the boilerplate needed to turn an {@link AsDbReadableController}
 * subclass into a fully wired HTTP controller for a given `@db.view` or `@db.table` model.
 *
 * Accepts the same three binding forms as {@link TableController}.
 *
 * @param binding Model token, lazy factory, or {@link AtscriptDbReadable} instance.
 * @param prefixOrOptions Route prefix string, or {@link TControllerBindingOptions}.
 *
 * @example
 * ```ts
 * ‎@ReadableController(ActiveTasks)
 * export class ActiveTasksController extends AsDbReadableController<typeof ActiveTasks> {}
 * ```
 */
export const ReadableController = <
  Readable extends AtscriptDbReadable<any, any, any, any, any, any, any>,
>(
  binding: TReadableBinding<Readable>,
  prefixOrOptions?: string | TControllerBindingOptions,
) => bindReadableController(binding, prefixOrOptions, "ReadableController");

/**
 * Alias for {@link ReadableController} — use with view-backed controllers.
 *
 * @example
 * ```ts
 * ‎@ViewController(ActiveTasks)
 * export class ActiveTasksController extends AsDbReadableController<typeof ActiveTasks> {}
 * ```
 */
export const ViewController = ReadableController;

/**
 * Finds the readable binding written by `@TableController` /
 * `@ReadableController` / `@ViewController` on a controller class, walking the
 * prototype chain so intermediate undecorated classes don't hide the binding
 * (nearest decorated ancestor wins).
 */
export function findReadableBinding(ctor: Function | undefined): TReadableBindingMeta | undefined {
  const mate = getAtscriptDbMate();
  let current: unknown = ctor;
  while (typeof current === "function") {
    const binding = mate.read(current as object)?.atscript_db_readable_binding;
    if (binding) {
      return binding;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/**
 * Resolves the readable bound to a controller class via
 * {@link findReadableBinding}, throwing with wiring guidance when none is
 * found.
 *
 * Used by {@link AsDbReadableController}'s constructor when `readable` is
 * `undefined` — i.e. a subclass with its own constructor called
 * `super(app)` instead of forwarding an injected instance.
 */
export function resolveBoundReadable(ctor: Function | undefined): AtscriptDbReadable<any> {
  const binding = findReadableBinding(ctor);
  if (binding) {
    return binding.resolve();
  }
  throw new Error(
    `[moost-db] ${ctor?.name || "controller"}: no readable bound. Either pass a table/view ` +
      `to super(...), or decorate the class with @TableController / @ReadableController ` +
      `(model token, lazy factory, or instance form).`,
  );
}
