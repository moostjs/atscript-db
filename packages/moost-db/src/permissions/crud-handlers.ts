import type { TCrudOp } from "@atscript/db";

/**
 * The handler method(s) serving each CRUD op on `AsDbReadableController` /
 * `AsDbController` — what a permission layer authorizes a `/meta` `crud`
 * entry through (an op is allowed when ANY of its handlers is). `one` is
 * served by `/one/:id` and `/one?…`, `remove` by `DELETE /:id` and
 * `DELETE /?…`. Readables (no writes) serve only the read ops.
 *
 * @since 0.1.143
 */
export const DB_CRUD_HANDLERS: Readonly<Record<TCrudOp, readonly string[]>> = Object.freeze({
  query: ["query"],
  pages: ["pages"],
  one: ["getOne", "getOneComposite"],
  geo: ["geo"],
  insert: ["insert"],
  update: ["update"],
  replace: ["replace"],
  remove: ["remove", "removeComposite"],
});

/**
 * The handler method(s) serving each CRUD op on the value-help controllers
 * (`AsValueHelpController` / `AsJsonValueHelpController` — read ops only,
 * no `geo`). Same contract as {@link DB_CRUD_HANDLERS}.
 *
 * @since 0.1.143
 */
export const VALUE_HELP_CRUD_HANDLERS: Readonly<Partial<Record<TCrudOp, readonly string[]>>> =
  Object.freeze({
    query: ["runQuery"],
    pages: ["runPages"],
    one: ["runGetOne", "runGetOneComposite"],
  });
