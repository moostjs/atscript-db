import type { FilterExpr } from "@atscript/db";
import type { TFilterVisitorOptions, TSqlFragment } from "@atscript/db-sql-tools";
import { buildWhere as _buildWhere } from "@atscript/db-sql-tools";

import { pgDialect } from "./sql-builder";

export type { TSqlFragment };

/**
 * Translates a filter expression into a parameterized PostgreSQL WHERE clause.
 *
 * Note: The returned fragment uses `?` placeholders (not `$N`).
 * Finalization to `$N` happens when the fragment is consumed by a DML builder
 * (buildSelect, buildUpdate, etc.) via the dialect's `paramPlaceholder`.
 *
 * Case-insensitive columns (`@db.collate 'nocase'`) are handled by CITEXT
 * column type at the storage level — no query-side wrapping needed.
 *
 * Relational predicates (`$some` / `$none`) render as correlated `EXISTS`
 * subqueries referencing the outer table by `opts.qualifier` (default: the
 * source table) — a statement with an aliased FROM must pass its alias.
 *
 * @param opts - since 0.1.147
 */
export function buildWhere(filter: FilterExpr, opts?: TFilterVisitorOptions): TSqlFragment {
  return _buildWhere(pgDialect, filter, opts);
}
