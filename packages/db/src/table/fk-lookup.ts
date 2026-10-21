import type { TFkLookupTarget } from "../types";

/** What {@link fkLookupTargetOf} reads a table through (any table / readable). */
interface TFkLookupSource {
  count(query: { filter: never }): Promise<number>;
  findMany(query: never): Promise<unknown[]>;
}

/**
 * The FK lookup target of a table: `count` and the key projection `find`
 * (`$select` of the target fields) that `validateRows({ fk: true })` diffs.
 * One wrapper for the space's resolver and a table's writable fallback.
 */
export function fkLookupTargetOf(table: TFkLookupSource): TFkLookupTarget {
  return {
    count: (filter) => table.count({ filter } as { filter: never }),
    find: (filter, fields) =>
      table.findMany({ filter, controls: { $select: [...fields] } } as never) as Promise<
        Array<Record<string, unknown>>
      >,
  };
}
