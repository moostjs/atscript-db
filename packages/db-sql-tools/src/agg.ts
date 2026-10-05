import { type AggregateExpr, BUCKET_UNITS, WEEK_STARTS, walkFilter } from "@uniqu/core";
import { DbError, type DbControls, type TResolvedBucket, type UniquSelect } from "@atscript/db";
import { assertAggregateFn, resolveAlias, type TDbAggregateFn } from "@atscript/db/agg";

import { sqlTimeZoneLiteral } from "./common";
import type { SqlDialect, TSqlFragment } from "./dialect";
import { EMPTY_AND, finalizeParams, havingGroupRef, orderKeySql } from "./dialect";
import { renderArith } from "./arith";
import { createFilterVisitor } from "./filter-builder";

/**
 * SQL function name of each single-name aggregate. `countDistinct` is not a
 * name but a form (`COUNT(DISTINCT x)`) — see {@link renderAggCall}.
 */
export const AGG_FN_SQL: Readonly<
  Record<Exclude<TDbAggregateFn, "countDistinct" | "first" | "last">, string>
> = {
  sum: "SUM",
  avg: "AVG",
  count: "COUNT",
  min: "MIN",
  max: "MAX",
};

/**
 * Renders one aggregate call over an already-rendered argument (`*`, a quoted
 * column, a `CASE` expression): `SUM(x)`, `COUNT(DISTINCT x)`, …
 * Re-asserts the name first (`INVALID_QUERY` on an unknown one), so nothing
 * unchecked reaches SQL.
 */
export function renderAggCall(fn: unknown, arg: string, path?: string): string {
  assertAggregateFn(fn, path);
  if (fn === "countDistinct") return `COUNT(DISTINCT ${arg})`;
  // `first` / `last` are never a plain call: they read the derived table's window columns.
  return `${AGG_FN_SQL[fn as keyof typeof AGG_FN_SQL]}(${arg})`;
}

/**
 * `MIN` / `MAX` of a column the engine may not aggregate directly: a boolean
 * on a dialect with {@link SqlDialect.booleanAggregates} (PostgreSQL has no
 * `MIN(boolean)`) renders its stand-in.
 */
function pickSql(
  dialect: SqlDialect,
  select: UniquSelect | undefined,
  fn: "min" | "max",
  column: string,
  sql: string,
): string {
  const bool =
    select?.sources.get(column)?.designType === "boolean"
      ? dialect.booleanAggregates?.[fn]
      : undefined;
  return bool ? `${bool}(${sql})` : renderAggCall(fn, sql);
}

/** The bare aggregate call, e.g. `SUM("amount")` / `COUNT(*)` / `COUNT(DISTINCT "region")`. */
function aggFnSql(dialect: SqlDialect, select: UniquSelect | undefined, expr: AggregateExpr) {
  if (expr.$field === "*") return renderAggCall(expr.$fn, "*");
  const field = dialect.quoteIdentifier(expr.$field);
  return expr.$fn === "min" || expr.$fn === "max"
    ? pickSql(dialect, select, expr.$fn as "min" | "max", expr.$field, field)
    : renderAggCall(expr.$fn, field);
}

const BUCKET_UNIT_SET: ReadonlySet<string> = new Set(BUCKET_UNITS);
const WEEK_START_SET: ReadonlySet<string> = new Set(WEEK_STARTS);

/**
 * The dialect's label expression for one calendar bucket.
 *
 * Internal assertions, once for every dialect, before it renders:
 * - the dialect has `calendarBucket` — the user-facing `BUCKET_NOT_SUPPORTED`
 *   is the core's (`calendarBucketUnits()`), so only an adapter advertising
 *   units its dialect cannot render reaches this throw;
 * - the literals a dialect inlines (the expression is parameter-free) are in
 *   their closed sets — unit, week start, ISO week start 1..7 — and the zone
 *   passes `sqlTimeZoneLiteral`'s charset. Defense in depth: the core's
 *   normalizer already validated all of them.
 */
function bucketSql(dialect: SqlDialect, bucket: TResolvedBucket): string {
  if (!dialect.calendarBucket) {
    throw new DbError("BUCKET_NOT_SUPPORTED", [
      { path: "$select", message: "Calendar buckets are not supported by this adapter" },
    ]);
  }
  const { unit, weekStart, weekStartIso } = bucket;
  for (const [ok, value] of [
    [BUCKET_UNIT_SET.has(unit), unit],
    [WEEK_START_SET.has(weekStart), weekStart],
    [Number.isInteger(weekStartIso) && weekStartIso >= 1 && weekStartIso <= 7, weekStartIso],
  ] as const) {
    if (!ok) {
      throw new DbError("INVALID_QUERY", [
        { path: "$select", message: `Invalid calendar bucket argument "${String(value)}"` },
      ]);
    }
  }
  sqlTimeZoneLiteral(bucket.tz);
  return dialect.calendarBucket(dialect.quoteIdentifier(bucket.field), bucket);
}

/**
 * The SQL a `$groupBy` key renders as: a calendar-bucket alias renders the
 * bucket EXPRESSION (`dialect.calendarBucket`), anything else the quoted
 * column. GROUP BY, HAVING and the count query's GROUP BY use it — PostgreSQL
 * rejects SELECT aliases in HAVING and lets an input column of the same name
 * win in GROUP BY, so the expression form is the legal, unambiguous rendering
 * there (HAVING on MySQL is the exception — see `SqlDialect.bucketAliasInHaving`).
 * SELECT and GROUP BY render identical, parameter-free text (PostgreSQL /
 * MySQL `ONLY_FULL_GROUP_BY` match them structurally); ORDER BY keeps the
 * bare output alias.
 */
export function groupKeySql(dialect: SqlDialect, controls: DbControls, key: string): string {
  const bucket = controls.$select?.bucketByAlias(key);
  return bucket ? bucketSql(dialect, bucket) : dialect.quoteIdentifier(key);
}

/** Alias of the derived table `first` / `last` aggregates read from. */
const ROWS_ALIAS = "__as_rows";

/** The derived-table column of the `i`-th `first` / `last` entry. */
const firstLastColumn = (i: number) => `__as_fl${i}`;

/**
 * The SQL each computed alias stands for where an alias is not usable
 * (HAVING; other expressions): an aggregate's call, a `first` / `last`
 * derived column (aggregated: constant within its group), a row-level
 * expression aggregate's call, and every group-level expression rendered over
 * those (in dependency order, operands cast to double). A grouped column
 * renders as its quoted name.
 */
function aliasSqlMap(dialect: SqlDialect, controls: DbControls): Map<string, string> {
  const map = new Map<string, string>();
  const select = controls.$select;
  const quote = (name: string) => dialect.quoteIdentifier(name);
  for (const expr of select?.aggregates ?? []) {
    map.set(resolveAlias(expr), aggFnSql(dialect, select, expr));
  }
  for (const e of select?.exprAggregates ?? []) {
    map.set(e.alias, renderAggCall(e.fn, renderArith(dialect, e.expr, quote)));
  }
  (select?.firstLast ?? []).forEach((fl, i) => {
    // constant within its group: any value of it, whatever the column type
    const col = quote(firstLastColumn(i));
    map.set(fl.alias, dialect.anyValue ? dialect.anyValue(col) : renderAggCall("min", col));
  });
  for (const e of select?.exprs ?? []) {
    map.set(
      e.alias,
      renderArith(dialect, e.expr, (name) => map.get(name) ?? quote(name)),
    );
  }
  return map;
}

/** A rendered HAVING and the keys its predicate names. */
interface THaving extends TSqlFragment {
  refs: ReadonlySet<string>;
}

/**
 * ` HAVING <predicate>` (leading space) + params for `controls.$having`, or
 * `undefined` when there is nothing to render. Shared by the row and the
 * count builders so both filter the same group set.
 *
 * A key that names a computed alias (`$as`, else `fn_field`) renders what the
 * alias stands for — `SUM("amount") > ?`, an expression's arithmetic — because
 * PostgreSQL does not allow a SELECT alias in HAVING (MySQL and SQLite
 * tolerate it, so the expression form keeps all three identical). A
 * calendar-bucket alias renders its bucket expression ({@link groupKeySql}),
 * or its quoted alias when the dialect sets `SqlDialect.bucketAliasInHaving`
 * (`havingGroupRef`). Other keys (grouped columns) render as plain columns.
 * `aliasSql` is the query's {@link aliasSqlMap} when the caller has built it.
 */
function havingClause(
  dialect: SqlDialect,
  controls: DbControls,
  aliasSql?: ReadonlyMap<string, string>,
): THaving | undefined {
  const having = controls.$having;
  if (!having) return undefined;
  const exprByAlias = aliasSql ?? aliasSqlMap(dialect, controls);
  const refs = new Set<string>();
  const visitor = createFilterVisitor(dialect, {
    columnRef: (field) => {
      refs.add(field);
      const aggExpr = exprByAlias.get(field);
      if (aggExpr) return aggExpr;
      const bucket = controls.$select?.bucketByAlias(field);
      return bucket
        ? havingGroupRef(dialect, bucketSql(dialect, bucket), field)
        : dialect.quoteIdentifier(field);
    },
  });
  const fragment = walkFilter(having, visitor);
  if (!fragment || fragment.sql === EMPTY_AND.sql) return undefined;
  return { sql: ` HAVING ${fragment.sql}`, params: fragment.params, refs };
}

/** `<bucket expr> AS "alias"` for every calendar bucket in `$select`. */
function bucketSelectParts(dialect: SqlDialect, controls: DbControls): string[] {
  return (controls.$select?.buckets ?? []).map(
    (bucket) => `${bucketSql(dialect, bucket)} AS ${dialect.quoteIdentifier(bucket.alias)}`,
  );
}

/** ` GROUP BY <keys>` (leading space), or `""` for the whole table as one group. */
function groupByClause(dialect: SqlDialect, controls: DbControls): string {
  const keys = (controls.$groupBy as string[] | undefined) ?? [];
  return keys.length
    ? ` GROUP BY ${keys.map((key) => groupKeySql(dialect, controls, key)).join(", ")}`
    : "";
}

/** Whether any of the HAVING keys is a `first` / `last` alias, or an expression over one. */
function readsFirstLast(select: UniquSelect | undefined, refs: ReadonlySet<string>): boolean {
  if (!select?.firstLast) return false;
  const firstLast = new Set(select.firstLast.map((fl) => fl.alias));
  const names = new Map((select.exprs ?? []).map((e) => [e.alias, e.names] as const));
  const visit = (name: string, seen: Set<string>): boolean => {
    if (firstLast.has(name)) return true;
    const deps = names.get(name);
    if (!deps || seen.has(name)) return false;
    seen.add(name);
    return deps.some((dep) => visit(dep, seen));
  };
  return [...refs].some((key) => visit(key, new Set()));
}

/**
 * The columns the outer query reads from the derived table of a `first` /
 * `last` aggregate: group keys (a bucket's source for its alias), plain
 * `$select` fields, aggregate fields and the leaves of row-level expressions.
 * The `$rowOrder` columns and the `first` / `last` sources stay inside the
 * window; a group-level expression, `$having` and `$sort` read aliases or
 * group keys only.
 */
function rowColumns(controls: DbControls): string[] {
  const select = controls.$select;
  const columns = new Set<string>();
  for (const key of (controls.$groupBy as string[] | undefined) ?? []) {
    if (!select?.bucketByAlias(key)) columns.add(key);
  }
  for (const bucket of select?.buckets ?? []) columns.add(bucket.field);
  for (const field of select?.asArray ?? []) columns.add(field);
  for (const expr of select?.aggregates ?? []) {
    if (expr.$field !== "*") columns.add(expr.$field);
  }
  for (const e of select?.exprAggregates ?? []) {
    for (const name of e.names) columns.add(name);
  }
  return [...columns];
}

/**
 * The row source of an aggregate: `FROM <table> WHERE <where>`; with `first` /
 * `last` (and `withRows`) a derived table instead — the table's rows that
 * pass the WHERE, only the columns {@link rowColumns} lists, plus one
 * `FIRST_VALUE(col) OVER (PARTITION BY <group keys> ORDER BY <rowOrder>)`
 * column per entry (`last` over the reversed order). Each group then reads its
 * representative row's value as an aggregate (constant within the group). The
 * WHERE moves inside unchanged, so the bind parameters keep their order.
 */
function aggSource(
  dialect: SqlDialect,
  table: string,
  where: TSqlFragment,
  controls: DbControls,
  withRows: boolean,
): string {
  const quotedTable = dialect.quoteTable(table);
  const firstLast = controls.$select?.firstLast;
  const rowOrder = controls.$select?.rowOrder;
  if (!withRows || !firstLast?.length || !rowOrder?.length) {
    return `FROM ${quotedTable} WHERE ${where.sql}`;
  }
  const groupBy = controls.$groupBy as string[] | undefined;
  const partition = groupBy?.length
    ? `PARTITION BY ${groupBy.map((key) => groupKeySql(dialect, controls, key)).join(", ")} `
    : "";
  const order = (reverse: boolean) =>
    rowOrder
      .map((k) => orderKeySql(dialect, dialect.quoteIdentifier(k.column), k.desc !== reverse))
      .join(", ");
  const columns = [
    ...rowColumns(controls).map((column) => dialect.quoteIdentifier(column)),
    ...firstLast.map((fl, i) => {
      const col = dialect.quoteIdentifier(firstLastColumn(i));
      return `FIRST_VALUE(${dialect.quoteIdentifier(fl.column)}) OVER (${partition}ORDER BY ${order(fl.fn === "last")}) AS ${col}`;
    }),
  ];
  return `FROM (SELECT ${columns.join(", ")} FROM ${quotedTable} WHERE ${where.sql}) AS ${dialect.quoteIdentifier(ROWS_ALIAS)}`;
}

/**
 * Builds a SELECT ... GROUP BY statement with aggregate functions.
 *
 * SELECT lists the plain grouped columns, then `<bucket expr> AS "alias"`
 * per calendar bucket, then every computed alias (aggregates, row-level
 * expression aggregates, `first` / `last`, group-level expressions — the
 * order of `UniquSelect.computedAliases`). Bucket expressions are
 * parameter-free, so the bind parameters are exactly those of the same query
 * without buckets (WHERE, HAVING, LIMIT, OFFSET).
 */
export function buildAggregateSelect(
  dialect: SqlDialect,
  table: string,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  const select = controls.$select;
  const selectParts: string[] = [];

  // Dimension fields (plain strings from $select)
  for (const f of select?.asArray ?? []) {
    selectParts.push(dialect.quoteIdentifier(f));
  }

  // Calendar buckets: `<label expr> AS "alias"`
  selectParts.push(...bucketSelectParts(dialect, controls));

  // Computed entries. Plain aggregates render directly; with expressions or
  // `first` / `last` the alias map renders each once, for the select list,
  // other expressions and HAVING alike.
  let aliasSql: Map<string, string> | undefined;
  if (select?.exprAggregates || select?.firstLast || select?.exprs) {
    aliasSql = aliasSqlMap(dialect, controls);
    for (const alias of select.computedAliases) {
      selectParts.push(`${aliasSql.get(alias)} AS ${dialect.quoteIdentifier(alias)}`);
    }
  } else {
    for (const expr of select?.aggregates ?? []) {
      selectParts.push(
        `${aggFnSql(dialect, select, expr)} AS ${dialect.quoteIdentifier(resolveAlias(expr))}`,
      );
    }
  }

  const cols = selectParts.length > 0 ? selectParts.join(", ") : "*";

  let sql = `SELECT ${cols} ${aggSource(dialect, table, where, controls, true)}${groupByClause(dialect, controls)}`;
  const params = [...where.params];

  // HAVING
  const having = havingClause(dialect, controls, aliasSql);
  if (having) {
    sql += having.sql;
    params.push(...having.params);
  }

  // ORDER BY — bare names: output aliases (aggregate or bucket) are legal here on every dialect.
  // NULL is the smallest value everywhere (`orderKeySql`: NULLS FIRST / LAST where the engine differs).
  if (controls.$sort) {
    const orderParts: string[] = [];
    for (const [col, dir] of Object.entries(controls.$sort)) {
      orderParts.push(orderKeySql(dialect, dialect.quoteIdentifier(col), dir === -1));
    }
    if (orderParts.length > 0) {
      sql += ` ORDER BY ${orderParts.join(", ")}`;
    }
  }

  // LIMIT / OFFSET
  if (controls.$limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(controls.$limit);
  }

  if (controls.$skip !== undefined) {
    if (controls.$limit === undefined) {
      sql += ` LIMIT ${dialect.unlimitedLimit}`;
    }
    sql += ` OFFSET ?`;
    params.push(controls.$skip);
  }

  return finalizeParams(dialect, { sql, params });
}

/**
 * Builds a COUNT query for the number of distinct groups — the groups that
 * survive `$having` when one is given (the same predicate the row query
 * renders, so `$count` agrees with the row set). Returns `{ count: N }` when
 * executed. The rows come straight from the table, unless `$having` reads a
 * `first` / `last` value (or an expression over one): only then the window
 * derived table is built.
 */
export function buildAggregateCount(
  dialect: SqlDialect,
  table: string,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  const groupFields = controls.$groupBy as string[] | undefined;
  const having = havingClause(dialect, controls);
  const countCol = `COUNT(*) AS ${dialect.quoteIdentifier("count")}`;
  if (!groupFields?.length && !having) {
    // Ungrouped aggregates are ONE result row whatever the input (even none): that is
    // what the row query returns, so that is what is counted.
    if ((controls.$select?.computedAliases.length ?? 0) > 0) {
      return finalizeParams(dialect, {
        sql: `SELECT 1 AS ${dialect.quoteIdentifier("count")}`,
        params: [],
      });
    }
    // No aggregates at all — just count all matching rows
    const sql = `SELECT ${countCol} FROM ${dialect.quoteTable(table)} WHERE ${where.sql}`;
    return finalizeParams(dialect, { sql, params: where.params });
  }
  const from = aggSource(
    dialect,
    table,
    where,
    controls,
    !!having && readsFirstLast(controls.$select, having.refs),
  );
  const groupBy = groupByClause(dialect, controls);

  // HAVING without GROUP BY treats the whole table as one group (0 or 1).
  // The inner select must then be an aggregate — SQLite rejects
  // `SELECT 1 … HAVING` without GROUP BY — so it counts instead of `SELECT 1`;
  // the subquery keeps the outer COUNT(*) at exactly one row either way.
  // A grouped inner select lists the calendar buckets (`<expr> AS alias`,
  // legal on every dialect) so a HAVING that names one by alias
  // (`SqlDialect.bucketAliasInHaving`) resolves; the expressions are
  // parameter-free, so the bind order is unchanged.
  let inner = "COUNT(*)";
  if (groupBy) {
    inner = bucketSelectParts(dialect, controls).join(", ") || "1";
  }
  const sql = `SELECT ${countCol} FROM (SELECT ${inner} ${from}${groupBy}${having?.sql ?? ""}) AS ${dialect.quoteIdentifier("_groups")}`;
  return finalizeParams(dialect, { sql, params: [...where.params, ...(having?.params ?? [])] });
}
