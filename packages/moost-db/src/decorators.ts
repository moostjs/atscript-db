import type { AtscriptDbTable, AtscriptDbReadable } from "@atscript/db";
import { Controller, Provide, ApplyDecorators, Inherit } from "moost";

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
 * Combines the boilerplate needed to turn an {@link AsDbController}
 * subclass into a fully wired HTTP controller for a given `@db.table` model.
 *
 * Internally applies three decorators:
 * 1. **Provide** — registers the table instance under {@link TABLE_DEF}.
 * 2. **Controller** — registers the class as a Moost HTTP controller
 *    with an optional route prefix. Defaults to `table.tableName`.
 * 3. **Inherit** — copies metadata (routes, guards, etc.) from the
 *    parent class so they stay active in the derived controller.
 *
 * @param table  The {@link AtscriptDbTable} instance for this controller.
 * @param prefix Optional route prefix. Defaults to `table.tableName`.
 *
 * @example
 * ```ts
 * ‎@TableController(usersTable)
 * export class UsersController extends AsDbController<typeof UserModel> {}
 * ```
 */
export const TableController = (table: AtscriptDbTable, prefix?: string) =>
  ApplyDecorators(
    Provide(TABLE_DEF, () => table),
    Controller(prefix || table.tableName),
    Inherit(),
  );

/**
 * Combines the boilerplate needed to turn an {@link AsDbReadableController}
 * subclass into a fully wired HTTP controller for a given `@db.view` or `@db.table` model.
 *
 * @param readable  The {@link AtscriptDbReadable} instance (table or view).
 * @param prefix    Optional route prefix. Defaults to `readable.tableName`.
 *
 * @example
 * ```ts
 * ‎@ReadableController(activeTasksView)
 * export class ActiveTasksController extends AsDbReadableController<typeof ActiveTasks> {}
 * ```
 */
export const ReadableController = (readable: AtscriptDbReadable, prefix?: string) =>
  ApplyDecorators(
    Provide(READABLE_DEF, () => readable),
    Controller(prefix || readable.tableName),
    Inherit(),
  );

/**
 * Alias for {@link ReadableController} — use with view-backed controllers.
 *
 * @example
 * ```ts
 * ‎@ViewController(activeTasksView)
 * export class ActiveTasksController extends AsDbReadableController<typeof ActiveTasks> {}
 * ```
 */
export const ViewController = ReadableController;
