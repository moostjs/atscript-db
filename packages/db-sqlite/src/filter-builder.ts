import type { FilterExpr } from "@uniqu/core";
import { buildWhere as _buildWhere } from "@atscript/db-sql-tools";
import type { TFilterVisitorOptions, TSqlFragment } from "@atscript/db-sql-tools";
import { sqliteDialect, esc } from "./sql-builder";

export type { TSqlFragment } from "@atscript/db-sql-tools";

/**
 * Translates a uniqu filter expression into a parameterized SQL WHERE clause.
 *
 * Relational predicates (`$some` / `$none`) render as correlated `EXISTS`
 * subqueries referencing the outer table by `opts.qualifier` (default: the
 * source table name) — a statement with an aliased FROM must pass its alias.
 *
 * @param opts - since 0.1.147
 * @returns `{ sql, params }` — the WHERE clause (without "WHERE") and bound params.
 *          Returns `{ sql: '1=1', params: [] }` for empty/null filters.
 */
export function buildWhere(filter: FilterExpr, opts?: TFilterVisitorOptions): TSqlFragment {
  return _buildWhere(sqliteDialect, filter, opts);
}

/**
 * Like {@link buildWhere} but prefixes all column references with a table alias.
 * Produces `alias."col"` instead of `"col"` — needed for JOINed queries (e.g. FTS5 search).
 * Relational predicates correlate to the same alias (since 0.1.147); their
 * own subquery aliases stay unprefixed.
 */
export function buildPrefixedWhere(alias: string, filter: FilterExpr): TSqlFragment {
  return _buildWhere(sqliteDialect, filter, {
    columnRef: (name) => `${alias}."${esc(name)}"`,
    qualifier: alias,
  });
}
