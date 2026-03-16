import type { FilterExpr } from "@uniqu/core";
import { buildWhere as _buildWhere } from "@atscript/db-sql-tools";
import type { TSqlFragment } from "@atscript/db-sql-tools";
import { mysqlDialect } from "./sql-builder";

export type { TSqlFragment } from "@atscript/db-sql-tools";

/**
 * Translates a uniqu filter expression into a parameterized MySQL WHERE clause.
 *
 * @returns `{ sql, params }` — the WHERE clause (without "WHERE") and bound params.
 *          Returns `{ sql: '1=1', params: [] }` for empty/null filters.
 */
export function buildWhere(filter: FilterExpr): TSqlFragment {
  return _buildWhere(mysqlDialect, filter);
}
