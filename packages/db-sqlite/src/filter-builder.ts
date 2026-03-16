import type { FilterExpr } from "@uniqu/core";
import { buildWhere as _buildWhere } from "@atscript/db-sql-tools";
import type { TSqlFragment } from "@atscript/db-sql-tools";
import { sqliteDialect, esc } from "./sql-builder";

export type { TSqlFragment } from "@atscript/db-sql-tools";

/**
 * Translates a uniqu filter expression into a parameterized SQL WHERE clause.
 *
 * @returns `{ sql, params }` — the WHERE clause (without "WHERE") and bound params.
 *          Returns `{ sql: '1=1', params: [] }` for empty/null filters.
 */
export function buildWhere(filter: FilterExpr): TSqlFragment {
  return _buildWhere(sqliteDialect, filter);
}

/**
 * Like {@link buildWhere} but prefixes all column references with a table alias.
 * Produces `alias."col"` instead of `"col"` — needed for JOINed queries (e.g. FTS5 search).
 */
export function buildPrefixedWhere(alias: string, filter: FilterExpr): TSqlFragment {
  return _buildWhere(
    {
      ...sqliteDialect,
      quoteIdentifier(name: string) {
        return `${alias}."${esc(name)}"`;
      },
    },
    filter,
  );
}
