import { ApplyDecorators, Resolve, getMoostMate } from "moost";
import { current } from "@wooksjs/event-core";

import { dbActionRowSlot, dbActionRowsSlot } from "./row-cache";
import { MOOST_DB_ACTION_ROW, MOOST_DB_ACTION_ROWS } from "./keys";

function createRowParamDecorator(
  metaKey: typeof MOOST_DB_ACTION_ROW | typeof MOOST_DB_ACTION_ROWS,
  slot: typeof dbActionRowSlot | typeof dbActionRowsSlot,
  resolverName: string,
): ParameterDecorator {
  const mate = getMoostMate();
  return ApplyDecorators(
    mate.decorate(metaKey, true),
    Resolve(async () => current().get(slot), resolverName),
  );
}

/**
 * Parameter decorator that injects the row whose PK was supplied in the
 * request body. Reads from the cached row wook (fetched once per request,
 * shared with the gate interceptor when `disabled` is set).
 *
 * Marks the param so {@link discoverActions} infers the action's `level` as
 * `'row'`. Co-occurrence with `@DbActionRows()` (or any multi-cardinality
 * decorator) drops the action with a warning.
 *
 * In `'skip'` mode this returns the gate's filtered row; the original
 * request-body row is not retrievable.
 */
export function DbActionRow(): ParameterDecorator {
  return createRowParamDecorator(MOOST_DB_ACTION_ROW, dbActionRowSlot, "dbActionRow");
}

/**
 * Parameter decorator that injects the rows-array fetched by primary keys
 * from the request body. Reads from the cached row-array wook.
 *
 * Marks the param so {@link discoverActions} infers the action's `level` as
 * `'rows'`. In `'rows'` + `'skip'` mode the resolved value contains only the
 * gate's surviving rows.
 */
export function DbActionRows(): ParameterDecorator {
  return createRowParamDecorator(MOOST_DB_ACTION_ROWS, dbActionRowsSlot, "dbActionRows");
}
