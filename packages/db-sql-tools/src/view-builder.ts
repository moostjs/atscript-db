import type {
  AtscriptExprNode,
  AtscriptQueryFieldRef,
  TViewColumnMapping,
  TViewJoin,
  TViewPlan,
} from "@atscript/db";

import type { SqlDialect } from "./dialect";
import { havingGroupRef } from "./dialect";
import { queryNodeToSql } from "./common";
import { renderAggCall } from "./agg";

/**
 * The SQL expression a view column reads: `"table"."column"` — the physical
 * source column resolved by `AtscriptDbView.getViewColumnMappings()` — or,
 * for a primitive leaf inside a JSON column (`mapping.json`), the dialect's
 * typed {@link SqlDialect.jsonExtract} over that column. Used for SELECT
 * columns, GROUP BY / HAVING dimensions and as an aggregate's source.
 *
 * @throws when the column reads a JSON leaf and the dialect has no `jsonExtract`.
 */
export function viewSourceExpr(dialect: SqlDialect, mapping: TViewColumnMapping): string {
  const col = `${dialect.quoteIdentifier(mapping.sourceTable)}.${dialect.quoteIdentifier(mapping.sourceColumn)}`;
  if (!mapping.json) {
    return col;
  }
  if (!dialect.jsonExtract) {
    throw new Error(
      `View column "${mapping.viewColumn}": JSON extraction is not supported by this adapter`,
    );
  }
  return dialect.jsonExtract(col, mapping.json.path, mapping.json.type);
}

/**
 * The SQL expression of one aggregate view column, e.g. `SUM("orders"."amount")`,
 * `COUNT(*)` or `COUNT(DISTINCT "orders"."customer_id")`, over
 * {@link viewSourceExpr}. The mapping's aggregate rules (`*` only for count, …)
 * are validated where the core builds it.
 *
 * A conditional aggregate (`aggFilter`, rendered with the view's predicate
 * resolver) aggregates `CASE WHEN <predicate> THEN <src> END` — NULL for the
 * rows the predicate rejects, which every aggregate skips:
 * - `COUNT(*)` → `COUNT(CASE WHEN p THEN 1 END)`;
 * - `countDistinct` → `COUNT(DISTINCT CASE WHEN p THEN src END)`;
 * - `sum` → `COALESCE(SUM(CASE WHEN p THEN src END), 0)` — a group with no
 *   matching row sums to 0, not NULL (MongoDB's `$sum` answer too);
 * - `avg` / `min` / `max` stay NULL when no row matches.
 */
export function viewAggExpr(
  dialect: SqlDialect,
  c: TViewColumnMapping,
  resolveFieldRef: (ref: AtscriptQueryFieldRef) => string,
): string {
  const star = c.aggField === "*";
  const src = star ? "*" : viewSourceExpr(dialect, c);
  if (!c.aggFilter) {
    return renderAggCall(c.aggFn, src, c.viewColumn);
  }
  const predicate = queryNodeToSql(c.aggFilter, resolveFieldRef);
  const call = renderAggCall(
    c.aggFn,
    `CASE WHEN ${predicate} THEN ${star ? "1" : src} END`,
    c.viewColumn,
  );
  return c.aggFn === "sum" ? `COALESCE(${call}, 0)` : call;
}

/**
 * The SQL expression of a computed view column (`@db.compute`), evaluated in
 * IEEE double on every dialect: each field and literal leaf is cast with
 * {@link SqlDialect.castDouble} (a computed leaf is already a double and is
 * inlined); `+ - *` render as `(l op r)`, `/` as `(l / NULLIF(r, 0))` —
 * division by zero is NULL — unary minus as `(-x)`, `coalesce` as
 * `COALESCE(…)`. A leaf reads its column like the SELECT list does: an
 * aggregate's call ({@link viewAggExpr}) or a dimension's source
 * ({@link viewSourceExpr}). `byPath` holds the view's mappings by `viewPath`.
 *
 * In a `grouped` view a JSON-extracted dimension leaf reads `MIN(<extract>)`:
 * the extraction is a GROUP BY key, so every row of a group holds the same
 * value, but MySQL's ONLY_FULL_GROUP_BY rejects an expression over the raw
 * JSON column (which is not itself grouped) — the aggregate form is accepted
 * everywhere and yields that same value.
 *
 * @throws when the dialect has no `castDouble`, or a leaf names no column.
 * @since 0.1.147
 */
export function viewComputeExpr(
  dialect: SqlDialect,
  c: TViewColumnMapping,
  byPath: ReadonlyMap<string, TViewColumnMapping>,
  resolveFieldRef: (ref: AtscriptQueryFieldRef) => string,
  grouped = false,
  cache = new Map<string, string>(),
): string {
  const cached = cache.get(c.viewPath);
  if (cached !== undefined) return cached;
  const cast = dialect.castDouble?.bind(dialect);
  if (!cast) {
    throw new Error(
      `View column "${c.viewColumn}": computed view columns are not supported by this adapter`,
    );
  }
  const render = (e: AtscriptExprNode): string => {
    if (typeof e === "number") {
      if (!Number.isFinite(e)) {
        throw new Error(`View column "${c.viewColumn}": non-finite literal in @db.compute`);
      }
      return cast(String(e));
    }
    if ("field" in e) {
      const leaf = byPath.get(e.field);
      if (!leaf) {
        throw new Error(`View column "${c.viewColumn}": "${e.field}" is not a column of the view`);
      }
      if (leaf.expr !== undefined) {
        return viewComputeExpr(dialect, leaf, byPath, resolveFieldRef, grouped, cache);
      }
      if (leaf.aggFn) return cast(viewAggExpr(dialect, leaf, resolveFieldRef));
      const source = viewSourceExpr(dialect, leaf);
      return cast(grouped && leaf.json ? `MIN(${source})` : source);
    }
    const args = e.args.map(render);
    switch (e.op) {
      case "neg": {
        return `(-${args[0]})`;
      }
      case "coalesce": {
        return `COALESCE(${args.join(", ")})`;
      }
      case "/": {
        return `(${args[0]} / NULLIF(${args[1]}, 0))`;
      }
      default: {
        return `(${args[0]} ${e.op} ${args[1]})`;
      }
    }
  };
  const sql = render(c.expr!);
  cache.set(c.viewPath, sql);
  return sql;
}

/**
 * The `ON` clause of a first-row join (`join.first`): the joined row is the
 * one whose primary key equals the key of the FIRST matching target row —
 * a correlated scalar subquery
 * `"T"."id" = (SELECT "T"."id" FROM "table" AS "T" WHERE <condition> ORDER BY … LIMIT 1)`.
 * The inner `FROM` repeats the join's own target / alias text, so the
 * condition's refs to the joined scope bind to the inner row (SQL name
 * shadowing) while refs to the entry and earlier joins stay correlated to
 * the outer query. The ordering ends with the primary key, so the pick is
 * deterministic; NULL sorts first in `asc` (`nullsSortLargest` dialects
 * render `NULLS FIRST` / `NULLS LAST`). No window functions — SQLite, MySQL 8
 * and PostgreSQL render it alike.
 * @since 0.1.147
 */
function firstRowOn(
  dialect: SqlDialect,
  join: TViewJoin,
  target: string,
  condition: string,
  resolveFieldRef: (ref: AtscriptQueryFieldRef) => string,
): string {
  const first = join.first!;
  const key = resolveFieldRef({ type: join.targetType, field: first.key });
  const orderBy = first.order
    .map(({ ref, desc }) => {
      const nulls = dialect.nullsSortLargest ? (desc ? " NULLS LAST" : " NULLS FIRST") : "";
      return `${resolveFieldRef(ref)} ${desc ? "DESC" : "ASC"}${nulls}`;
    })
    .join(", ");
  return `${key} = (SELECT ${key} FROM ${target} WHERE ${condition} ORDER BY ${orderBy} LIMIT 1)`;
}

/**
 * Builds a CREATE VIEW statement from a view plan and column mappings.
 *
 * Joins render in declaration order — `JOIN` (inner, the default) or
 * `LEFT JOIN` for `kind: "left"`; a `@db.alias` target renders as
 * `JOIN "table" AS "Alias"` and is addressed by the alias everywhere else
 * (since 0.1.141). Column mappings carry PHYSICAL source names (the alias
 * name for an aliased join); `resolveFieldRef` renders predicate refs (join
 * ON, WHERE, HAVING fallbacks) as `"table"."column"`. The entry table and a
 * join target may be views.
 */
export function buildCreateView(
  dialect: SqlDialect,
  viewName: string,
  plan: TViewPlan,
  columns: TViewColumnMapping[],
  resolveFieldRef: (ref: AtscriptQueryFieldRef) => string,
): string {
  const columnByPath = new Map(columns.map((c) => [c.viewPath, c]));
  const hasAggregates = columns.some((c) => c.aggFn);
  // Rendered computed columns by view path (inlined into dependents, reused in HAVING)
  const computedSql = new Map<string, string>();
  /** A column's SELECT expression: computed, aggregate or plain source. */
  const columnExpr = (c: TViewColumnMapping): string =>
    c.expr !== undefined
      ? viewComputeExpr(dialect, c, columnByPath, resolveFieldRef, hasAggregates, computedSql)
      : c.aggFn
        ? viewAggExpr(dialect, c, resolveFieldRef)
        : viewSourceExpr(dialect, c);

  // SELECT columns — wrap aggregate columns with their function
  const selectCols = columns
    .map((c) => `${columnExpr(c)} AS ${dialect.quoteIdentifier(c.viewColumn)}`)
    .join(", ");

  // FROM entry table
  let sql = `${dialect.createViewPrefix} ${dialect.quoteTable(viewName)} AS SELECT ${selectCols} FROM ${dialect.quoteIdentifier(plan.entryTable)}`;

  // JOINs — declaration order; a later join may reference an earlier one
  for (const join of plan.joins) {
    const condition = queryNodeToSql(join.condition, resolveFieldRef);
    const keyword = join.kind === "left" ? "LEFT JOIN" : "JOIN";
    const target =
      join.scope === join.targetTable
        ? dialect.quoteIdentifier(join.targetTable)
        : `${dialect.quoteIdentifier(join.targetTable)} AS ${dialect.quoteIdentifier(join.scope)}`;
    const onClause = join.first
      ? firstRowOn(dialect, join, target, condition, resolveFieldRef)
      : condition;
    sql += ` ${keyword} ${target} ON ${onClause}`;
  }

  // WHERE filter
  if (plan.filter) {
    const whereClause = queryNodeToSql(plan.filter, resolveFieldRef);
    sql += ` WHERE ${whereClause}`;
  }

  // GROUP BY + HAVING — only when aggregates are present
  if (hasAggregates) {
    const dimensionCols = columns.filter((c) => !c.aggFn && c.expr === undefined);
    if (dimensionCols.length > 0) {
      const groupByCols = dimensionCols.map((c) => viewSourceExpr(dialect, c)).join(", ");
      sql += ` GROUP BY ${groupByCols}`;
    }

    // HAVING — post-aggregation filter over logical view field names
    if (plan.having) {
      const havingResolver = (ref: AtscriptQueryFieldRef): string => {
        const col = ref.type ? undefined : columnByPath.get(ref.field);
        if (!col) {
          return resolveFieldRef(ref);
        }
        if (col.expr !== undefined) {
          // MySQL references the SELECT alias, PostgreSQL the expression
          return havingGroupRef(dialect, columnExpr(col), col.viewColumn);
        }
        if (col.aggFn) {
          return viewAggExpr(dialect, col, resolveFieldRef);
        }
        const expr = viewSourceExpr(dialect, col);
        // A JSON-extracted dimension reads its raw JSON column, which is not
        // itself in GROUP BY — see `havingGroupRef`.
        return col.json ? havingGroupRef(dialect, expr, col.viewColumn) : expr;
      };

      const havingClause = queryNodeToSql(plan.having, havingResolver);
      sql += ` HAVING ${havingClause}`;
    }
  }

  return sql;
}
