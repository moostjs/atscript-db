import {
  queryReadColumns,
  type AtscriptDbView,
  type DbQuery,
  type TReadColumnsKind,
  type TViewReadPlan,
} from "@atscript/db";

import type { SqlDialect } from "./dialect";
import type { TSqlDerivedSource, TSqlFromSource } from "./from-source";
import { buildViewSelect } from "./view-builder";

/** Rendered pruned definitions per read variant (variants are memoised by their view). */
const rendered = new WeakMap<TViewReadPlan, Map<SqlDialect, TSqlDerivedSource>>();

/** The structural view surface {@link viewReadSource} needs from an adapter's readable. */
interface TReadableLike {
  readonly isView: boolean;
  readonly tableName: string;
  readonly schema?: string;
}

/**
 * The FROM source of a read of `readable` (the adapter's registered table or
 * view): `tableName` unchanged, except for a managed view whose read does
 * not need some of its LEFT joins (`AtscriptDbView.readPlan` over the
 * columns `query` reads — {@link queryReadColumns}): then the view's own
 * definition without those joins ({@link buildViewSelect}), aliased as the
 * bare view name so every column reference — and the correlation of a
 * relational predicate — stays valid. A column of a dropped join is absent
 * from the derived table, so a reference the collector missed fails with
 * "unknown column" rather than reading wrong data.
 *
 * Never pruned: a table, an external view, a view in a schema (its
 * definition's unqualified names resolve against that schema, the derived
 * table's against the connection's), or anything `readPlan` keeps whole.
 * @since 0.1.153
 */
export function viewReadSource(
  dialect: SqlDialect,
  readable: TReadableLike,
  tableName: string,
  query: DbQuery,
  kind: TReadColumnsKind,
  partitionBy?: readonly string[],
): TSqlFromSource {
  if (!readable.isView || readable.schema) return tableName;
  const view = readable as unknown as AtscriptDbView;
  if (view.isExternal) return tableName;
  const variant = view.readPlan(queryReadColumns(query, kind, partitionBy));
  if (!variant) return tableName;
  let byDialect = rendered.get(variant);
  if (!byDialect) {
    byDialect = new Map();
    rendered.set(variant, byDialect);
  }
  let source = byDialect.get(dialect);
  if (!source) {
    const qi = (name: string) => dialect.quoteIdentifier(name);
    const select = buildViewSelect(dialect, variant.plan, variant.columns, (ref) =>
      view.resolveFieldRef(ref, qi),
    );
    source = {
      sql: `(${select}) AS ${qi(readable.tableName)}`,
      hint: dialect.derivedMergeHint ? `${dialect.derivedMergeHint(readable.tableName)} ` : "",
    };
    byDialect.set(dialect, source);
  }
  return source;
}
