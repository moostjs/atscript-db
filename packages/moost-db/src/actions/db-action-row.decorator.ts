import { ApplyDecorators, Resolve } from "moost";
import { current } from "@wooksjs/event-core";

import { getAtscriptDbMate } from "../mate";
import { dbActionRowSlot, dbActionRowsSlot } from "./row-cache";

function createRowParamDecorator(
  metaKey: "atscript_db_action_row" | "atscript_db_action_rows",
  slot: typeof dbActionRowSlot | typeof dbActionRowsSlot,
  resolverName: string,
): ParameterDecorator {
  return ApplyDecorators(
    getAtscriptDbMate().decorate(metaKey, true),
    Resolve(async () => current().get(slot), resolverName),
  );
}

/**
 * Parameter decorator that injects the row whose identifier was supplied in
 * the request body.
 *
 * Marks the param so {@link discoverActions} infers the action's `level` as
 * `'row'`. Co-occurrence with `@DbActionRows()` (or any multi-cardinality
 * decorator) drops the action with a warning.
 *
 * In `'skip'` mode this returns the gate's filtered row; the original
 * request-body row is not retrievable.
 */
export function DbActionRow(): ParameterDecorator {
  return createRowParamDecorator("atscript_db_action_row", dbActionRowSlot, "dbActionRow");
}

/**
 * Parameter decorator that injects the rows fetched by the identifiers
 * supplied in the request body.
 *
 * Marks the param so {@link discoverActions} infers the action's `level` as
 * `'rows'`. In `'rows'` + `'skip'` mode the resolved value contains only the
 * gate's surviving rows.
 */
export function DbActionRows(): ParameterDecorator {
  return createRowParamDecorator("atscript_db_action_rows", dbActionRowsSlot, "dbActionRows");
}
