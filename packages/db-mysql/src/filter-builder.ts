import type { FilterExpr } from "@uniqu/core";
import { buildWhere as _buildWhere } from "@atscript/db-sql-tools";
import type { TFilterVisitorOptions, TSqlFragment } from "@atscript/db-sql-tools";
import { mysqlDialect } from "./sql-builder";

export type { TSqlFragment } from "@atscript/db-sql-tools";

/**
 * Translates a uniqu filter expression into a parameterized MySQL WHERE clause.
 *
 * @returns `{ sql, params }` — the WHERE clause (without "WHERE") and bound params.
 *          Returns `{ sql: '1=1', params: [] }` for empty/null filters.
 *
 * Relational predicates (`$some` / `$none`) render as correlated `EXISTS`
 * subqueries referencing the outer table by `opts.qualifier` (default: the
 * source table) — a statement with an aliased FROM must pass its alias.
 *
 * @param opts - since 0.1.147
 */
export function buildWhere(filter: FilterExpr, opts?: TFilterVisitorOptions): TSqlFragment {
  return _buildWhere(mysqlDialect, filter, opts);
}
